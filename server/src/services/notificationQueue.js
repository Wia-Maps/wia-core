import { loadLocationCatalog } from '../config/locationCatalog.js';
import {
  getFirebaseMessaging,
  isFirebaseMessagingConfigured,
} from '../config/firebaseAdmin.js';
import NotificationEvent from '../models/NotificationEvent.js';
import NotificationFanoutJob from '../models/NotificationFanoutJob.js';
import NotificationSubscription from '../models/NotificationSubscription.js';

const JOB_BATCH_SIZE = 500;
const JOB_POLL_INTERVAL_MS = 1500;
const JOB_LOCK_TIMEOUT_MS = 90_000;
const MAX_JOB_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];

const INVALID_FCM_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

const TRANSIENT_FCM_ERROR_CODES = new Set([
  'app/network-error',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/unknown-error',
]);

let queueWorkerHandle = null;
let queueProcessorBusy = false;

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const chunkArray = (items, size) => {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const getRetryDelayMs = (attemptNumber) => {
  return RETRY_DELAYS_MS[Math.max(0, Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1))];
};

const toPushDataPayload = ({ eventId, locationId, locationName, module, title, body, data = {}, createdAt }) => {
  const payload = {
    eventId,
    locationId,
    locationName,
    module,
    title,
    body,
    url: `/map?location=${encodeURIComponent(locationId)}&source=notification`,
    createdAt,
  };

  return Object.fromEntries(
    Object.entries({
      ...payload,
      ...data,
    }).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)])
  );
};

const resolveSettledEventStatus = (deliveryStats) => {
  const totalRecipients = Number(deliveryStats?.totalRecipients ?? 0);
  const sent = Number(deliveryStats?.sent ?? 0);
  const failed = Number(deliveryStats?.failed ?? 0);

  if (totalRecipients === 0) {
    return 'completed';
  }

  if (sent === 0 && failed >= totalRecipients) {
    return 'failed';
  }

  if (failed > 0) {
    return 'partial_failed';
  }

  return 'completed';
};

const finalizeNotificationEventIfSettled = async (eventId) => {
  const pendingJobCount = await NotificationFanoutJob.countDocuments({
    eventId,
    status: { $in: ['queued', 'processing'] },
  });

  if (pendingJobCount > 0) {
    await NotificationEvent.findByIdAndUpdate(eventId, {
      status: 'processing',
    });
    return;
  }

  const notificationEvent = await NotificationEvent.findById(eventId)
    .select({ deliveryStats: 1 })
    .lean();

  if (!notificationEvent) {
    return;
  }

  await NotificationEvent.findByIdAndUpdate(eventId, {
    status: resolveSettledEventStatus(notificationEvent.deliveryStats),
    processedAt: new Date(),
  });
};

const claimNextFanoutJob = async () => {
  const now = new Date();
  const staleLockThreshold = new Date(now.getTime() - JOB_LOCK_TIMEOUT_MS);

  return NotificationFanoutJob.findOneAndUpdate(
    {
      $or: [
        {
          status: 'queued',
          nextAttemptAt: { $lte: now },
        },
        {
          status: 'processing',
          lockedAt: { $lte: staleLockThreshold },
        },
      ],
    },
    {
      $set: {
        status: 'processing',
        lockedAt: now,
      },
    },
    {
      new: true,
      sort: {
        nextAttemptAt: 1,
        createdAt: 1,
      },
    }
  ).lean();
};

const handleInvalidTokens = async (tokens) => {
  if (tokens.length === 0) {
    return;
  }

  await NotificationSubscription.deleteMany({
    fcmToken: { $in: tokens },
  });
};

const settleFailedJob = async ({ job, message, eventFailedCount }) => {
  await NotificationFanoutJob.findByIdAndUpdate(job._id, {
    $set: {
      status: 'failed',
      lockedAt: null,
      lastAttemptAt: new Date(),
      lastError: message,
      tokens: [],
    },
    $inc: {
      attempts: 1,
      failedCount: eventFailedCount,
    },
  });

  if (eventFailedCount > 0) {
    await NotificationEvent.findByIdAndUpdate(job.eventId, {
      $inc: {
        'deliveryStats.failed': eventFailedCount,
      },
    });
  }

  await finalizeNotificationEventIfSettled(job.eventId);
};

const queueRetryJob = async ({ job, retryTokens, sentCount, failedCount, message }) => {
  const nextAttemptNumber = job.attempts + 1;
  const retryAt = new Date(Date.now() + getRetryDelayMs(nextAttemptNumber));

  await NotificationFanoutJob.findByIdAndUpdate(job._id, {
    $set: {
      status: 'queued',
      lockedAt: null,
      lastAttemptAt: new Date(),
      lastError: message,
      tokens: retryTokens,
      nextAttemptAt: retryAt,
    },
    $inc: {
      attempts: 1,
      sentCount,
      failedCount,
    },
  });

  if (sentCount > 0 || failedCount > 0) {
    await NotificationEvent.findByIdAndUpdate(job.eventId, {
      $inc: {
        'deliveryStats.sent': sentCount,
        'deliveryStats.failed': failedCount,
      },
      $set: {
        status: 'processing',
      },
    });
  }
};

const completeJob = async ({ job, sentCount, failedCount, message, failedStatus = false }) => {
  await NotificationFanoutJob.findByIdAndUpdate(job._id, {
    $set: {
      status: failedStatus ? 'failed' : 'completed',
      lockedAt: null,
      lastAttemptAt: new Date(),
      lastError: message,
      tokens: [],
    },
    $inc: {
      attempts: 1,
      sentCount,
      failedCount,
    },
  });

  if (sentCount > 0 || failedCount > 0) {
    await NotificationEvent.findByIdAndUpdate(job.eventId, {
      $inc: {
        'deliveryStats.sent': sentCount,
        'deliveryStats.failed': failedCount,
      },
    });
  }

  await finalizeNotificationEventIfSettled(job.eventId);
};

const processClaimedFanoutJob = async (job) => {
  const messaging = getFirebaseMessaging();

  if (!messaging) {
    await settleFailedJob({
      job,
      message: 'Firebase messaging is unavailable.',
      eventFailedCount: job.tokens.length,
    });
    return;
  }

  try {
    const response = await messaging.sendEachForMulticast({
      tokens: job.tokens,
      data: toPushDataPayload({
        eventId: String(job.eventId),
        locationId: job.locationId,
        locationName: toTrimmedString(job.locationName),
        module: job.module,
        title: job.title,
        body: job.body,
        data: job.data,
        createdAt: job.createdAt instanceof Date ? job.createdAt.toISOString() : new Date().toISOString(),
      }),
    });

    let sentCount = 0;
    let failedCount = 0;
    const retryTokens = [];
    const invalidTokens = [];

    response.responses.forEach((entry, index) => {
      if (entry.success) {
        sentCount += 1;
        return;
      }

      const failedToken = job.tokens[index];
      const errorCode = entry.error?.code;

      if (errorCode && INVALID_FCM_TOKEN_CODES.has(errorCode)) {
        invalidTokens.push(failedToken);
        failedCount += 1;
        return;
      }

      if (errorCode && TRANSIENT_FCM_ERROR_CODES.has(errorCode)) {
        retryTokens.push(failedToken);
        return;
      }

      failedCount += 1;
      console.error(`FCM delivery failed for ${failedToken}:`, entry.error?.message || errorCode);
    });

    await handleInvalidTokens(invalidTokens);

    if (retryTokens.length > 0 && job.attempts + 1 < job.maxAttempts) {
      await queueRetryJob({
        job,
        retryTokens,
        sentCount,
        failedCount,
        message: 'Retrying transient FCM delivery failures.',
      });
      return;
    }

    const exhaustedFailures = retryTokens.length;

    await completeJob({
      job,
      sentCount,
      failedCount: failedCount + exhaustedFailures,
      message:
        exhaustedFailures > 0
          ? 'Notification delivery exhausted retry attempts.'
          : null,
      failedStatus: exhaustedFailures > 0 && sentCount === 0 && failedCount === 0,
    });
  } catch (error) {
    const attemptNumber = job.attempts + 1;
    const canRetry = attemptNumber < job.maxAttempts;

    if (canRetry) {
      await NotificationFanoutJob.findByIdAndUpdate(job._id, {
        $set: {
          status: 'queued',
          lockedAt: null,
          lastAttemptAt: new Date(),
          lastError: error.message || 'Notification delivery failed.',
          nextAttemptAt: new Date(Date.now() + getRetryDelayMs(attemptNumber)),
        },
        $inc: {
          attempts: 1,
        },
      });

      await NotificationEvent.findByIdAndUpdate(job.eventId, {
        $set: {
          status: 'processing',
        },
      });
      return;
    }

    await settleFailedJob({
      job,
      message: error.message || 'Notification delivery failed.',
      eventFailedCount: job.tokens.length,
    });
  }
};

const processPendingFanoutJobs = async () => {
  if (queueProcessorBusy) {
    return;
  }

  queueProcessorBusy = true;

  try {
    while (true) {
      const job = await claimNextFanoutJob();

      if (!job) {
        break;
      }

      await NotificationEvent.findByIdAndUpdate(job.eventId, {
        status: 'processing',
      });

      await processClaimedFanoutJob(job);
    }
  } catch (error) {
    console.error('Notification queue worker failed:', error.message || error);
  } finally {
    queueProcessorBusy = false;
  }
};

const buildNotificationEvent = async ({
  locationId,
  module,
  title,
  body,
  data = {},
}) => {
  const locations = await loadLocationCatalog();
  const location = locations.find((entry) => entry.locationId === locationId);
  const locationName = location?.name ?? locationId;

  return {
    locationId,
    locationName,
    module,
    title: module === 'power' && title === 'Power update' ? locationName : title,
    body,
    data,
  };
};

export const enqueueTrackedLocationNotification = async ({
  locationId,
  module,
  title,
  body,
  data = {},
}) => {
  const eventPayload = await buildNotificationEvent({
    locationId,
    module,
    title,
    body,
    data,
  });

  const subscriptions = await NotificationSubscription.find({
    trackedLocationIds: locationId,
  })
    .select({ fcmToken: 1 })
    .lean();

  const tokens = [...new Set(
    subscriptions
      .map((record) => toTrimmedString(record.fcmToken))
      .filter(Boolean)
  )];

  const messagingReady = isFirebaseMessagingConfigured() && Boolean(getFirebaseMessaging());
  const eventHasRecipients = tokens.length > 0;

  const notificationEvent = await NotificationEvent.create({
    ...eventPayload,
    status: eventHasRecipients && messagingReady ? 'queued' : eventHasRecipients ? 'failed' : 'completed',
    deliveryStats: {
      totalRecipients: tokens.length,
      sent: 0,
      failed: !messagingReady ? tokens.length : 0,
    },
    processedAt: eventHasRecipients && messagingReady ? null : new Date(),
  });

  if (!eventHasRecipients || !messagingReady) {
    return notificationEvent;
  }

  const notificationJobs = chunkArray(tokens, JOB_BATCH_SIZE).map((tokenBatch) => ({
    eventId: notificationEvent._id,
    locationId: eventPayload.locationId,
    module: eventPayload.module,
    title: eventPayload.title,
    body: eventPayload.body,
    data: eventPayload.data,
    locationName: eventPayload.locationName,
    tokens: tokenBatch,
    maxAttempts: MAX_JOB_ATTEMPTS,
    nextAttemptAt: new Date(),
  }));

  await NotificationFanoutJob.insertMany(notificationJobs);
  void processPendingFanoutJobs();

  return notificationEvent;
};

export const queuePowerStatusNotification = async ({ locationId, powerStatus }) => {
  return enqueueTrackedLocationNotification({
    locationId,
    module: 'power',
    title: 'Power update',
    body: `Power is ${powerStatus ? 'now available' : 'not available'}.`,
    data: {
      powerStatus,
    },
  });
};

export const startNotificationQueueWorker = () => {
  if (queueWorkerHandle) {
    return;
  }

  queueWorkerHandle = setInterval(() => {
    void processPendingFanoutJobs();
  }, JOB_POLL_INTERVAL_MS);

  void processPendingFanoutJobs();
};
