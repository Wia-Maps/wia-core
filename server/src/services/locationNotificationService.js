import { loadLocationCatalog } from '../config/locationCatalog.js';
import {
  getFirebaseMessaging,
  isFirebaseMessagingConfigured,
} from '../config/firebaseAdmin.js';
import NotificationSubscription from '../models/NotificationSubscription.js';

const INVALID_FCM_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

const chunkArray = (items, size) => {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

export const notifyTrackedLocationSubscribers = async ({
  locationId,
  title,
  body,
  data = {},
}) => {
  if (!isFirebaseMessagingConfigured()) {
    return { sent: 0, skipped: true };
  }

  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return { sent: 0, skipped: true };
  }

  const subscriptions = await NotificationSubscription.find({
    trackedLocationIds: locationId,
  }).lean();

  const tokens = subscriptions
    .map((record) => record.fcmToken)
    .filter((token) => typeof token === 'string' && token.length > 0);

  if (tokens.length === 0) {
    return { sent: 0, skipped: false };
  }

  let sent = 0;
  const invalidTokens = new Set();

  for (const tokenBatch of chunkArray(tokens, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: tokenBatch,
      data: {
        title,
        body,
        url: '/',
        locationId,
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)])
        ),
      },
    });

    response.responses.forEach((entry, index) => {
      if (entry.success) {
        sent += 1;
        return;
      }

      const failedToken = tokenBatch[index];
      const errorCode = entry.error?.code;

      if (errorCode && INVALID_FCM_TOKEN_CODES.has(errorCode)) {
        invalidTokens.add(failedToken);
        return;
      }

      console.error(`FCM notification failed for ${failedToken}:`, entry.error?.message || errorCode);
    });
  }

  if (invalidTokens.size > 0) {
    await NotificationSubscription.deleteMany({
      fcmToken: { $in: Array.from(invalidTokens) },
    });
  }

  return { sent, skipped: false };
};

export const notifyPowerStatusSubscribers = async ({ locationId, powerStatus }) => {
  const locations = await loadLocationCatalog();
  const location = locations.find((entry) => entry.locationId === locationId);
  const locationName = location?.name ?? locationId;

  return notifyTrackedLocationSubscribers({
    locationId,
    title: locationName,
    body: `Power is  ${powerStatus ? 'now available' : 'not available'}.`,
    data: {
      module: 'power',
      powerStatus,
    },
  });
};
