import RouteTelemetryBatch from '../models/RouteTelemetryBatch.js';
import { logAdminActivity } from './adminActivityService.js';
import { resolveCampusId } from './routeGeometry.js';
import { upsertAnalyticsCandidates } from './routeCandidateService.js';
import { upsertRoutingWeightOverlay } from './routingWeightService.js';

const DEFAULT_CLAIM_LIMIT = 25;
const MAX_CLAIM_LIMIT = 100;
const DEFAULT_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 1800;

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const clampInteger = (value, min, max, fallback) => {
  const normalized = Number.parseInt(String(value), 10);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, normalized));
};

const toWorkerActor = (workerId) => {
  const normalizedWorkerId = toTrimmedString(workerId) || 'default';
  return {
    adminId: 'analytics-worker',
    email: `analytics-worker:${normalizedWorkerId}`,
  };
};

const serializeTelemetryBatch = (batch) => {
  return {
    id: batch._id?.toString?.() ?? batch.id,
    campusId: batch.campusId,
    deviceId: batch.deviceId,
    sessionId: batch.sessionId,
    source: batch.source,
    points: batch.points ?? [],
    pointCount: batch.pointCount,
    startedAtMs: batch.startedAtMs,
    endedAtMs: batch.endedAtMs,
    processingStatus: batch.processingStatus,
    claimedAt: batch.claimedAt ? new Date(batch.claimedAt).toISOString() : null,
    claimedBy: batch.claimedBy ?? null,
    leaseExpiresAt: batch.leaseExpiresAt ? new Date(batch.leaseExpiresAt).toISOString() : null,
    processedAt: batch.processedAt ? new Date(batch.processedAt).toISOString() : null,
    metadata: batch.metadata ?? null,
    ingestedAt: batch.ingestedAt ? new Date(batch.ingestedAt).toISOString() : null,
  };
};

export const claimTelemetryBatchesForAnalytics = async ({
  campusId,
  limit = DEFAULT_CLAIM_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  workerId,
} = {}) => {
  const normalizedCampusId = campusId ? resolveCampusId(campusId) : '';
  const safeLimit = clampInteger(limit, 1, MAX_CLAIM_LIMIT, DEFAULT_CLAIM_LIMIT);
  const safeLeaseSeconds = clampInteger(
    leaseSeconds,
    30,
    MAX_LEASE_SECONDS,
    DEFAULT_LEASE_SECONDS
  );
  const normalizedWorkerId = toTrimmedString(workerId) || 'default';
  const claimed = [];

  for (let index = 0; index < safeLimit; index += 1) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + safeLeaseSeconds * 1000);
    const filter = {
      ...(normalizedCampusId ? { campusId: normalizedCampusId } : {}),
      $or: [
        { processingStatus: 'pending' },
        {
          processingStatus: 'processing',
          $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
        },
      ],
    };

    const batch = await RouteTelemetryBatch.findOneAndUpdate(
      filter,
      {
        $set: {
          processingStatus: 'processing',
          claimedAt: now,
          claimedBy: normalizedWorkerId,
          leaseExpiresAt,
        },
      },
      {
        sort: { ingestedAt: 1, _id: 1 },
        new: true,
      }
    ).lean();

    if (!batch) {
      break;
    }

    claimed.push(serializeTelemetryBatch(batch));
  }

  return {
    items: claimed,
    count: claimed.length,
    leaseSeconds: safeLeaseSeconds,
  };
};

export const completeTelemetryBatchForAnalytics = async (
  batchId,
  {
    status = 'processed',
    metadata = null,
    workerId,
  } = {}
) => {
  const normalizedBatchId = toTrimmedString(batchId);
  const normalizedStatus = status === 'discarded' ? 'discarded' : 'processed';
  const normalizedWorkerId = toTrimmedString(workerId) || 'default';

  if (!normalizedBatchId) {
    throw new Error('batchId is required.');
  }

  const batch = await RouteTelemetryBatch.findOne({
    _id: normalizedBatchId,
    processingStatus: 'processing',
    claimedBy: normalizedWorkerId,
  });

  if (!batch) {
    throw new Error(`Telemetry batch '${normalizedBatchId}' is not currently claimed by worker '${normalizedWorkerId}'.`);
  }

  batch.processingStatus = normalizedStatus;
  batch.processedAt = new Date();
  batch.claimedAt = null;
  batch.claimedBy = null;
  batch.leaseExpiresAt = null;
  batch.metadata = {
    ...(batch.metadata ?? {}),
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
  };

  await batch.save();

  return serializeTelemetryBatch(batch.toObject());
};

export const syncAnalyticsCandidates = async ({
  candidates,
} = {}) => {
  return upsertAnalyticsCandidates({
    candidates,
  });
};

export const syncRoutingWeightOverlay = async ({
  campusId,
  edges,
  metadata = null,
} = {}) => {
  return upsertRoutingWeightOverlay({
    campusId,
    edges,
    metadata,
  });
};

export const logAnalyticsWorkerRunSummary = async ({
  workerId,
  runId = '',
  campusId = '',
  telemetryClaimed = 0,
  telemetryProcessed = 0,
  telemetryDiscarded = 0,
  candidatesCreated = 0,
  candidatesUpdated = 0,
  overlaysUpdated = 0,
  notes = '',
  metadata = null,
} = {}) => {
  const normalizedWorkerId = toTrimmedString(workerId) || 'default';
  const normalizedCampusId = campusId ? resolveCampusId(campusId) : null;
  const normalizedRunId = toTrimmedString(runId) || null;
  const normalizedNotes = toTrimmedString(notes);

  return logAdminActivity({
    actionType: 'analytics_run_summary',
    targetType: 'analytics_worker',
    targetId: normalizedRunId,
    targetLabel: normalizedWorkerId,
    details:
      normalizedNotes ||
      `Analytics worker '${normalizedWorkerId}' processed ${Number(telemetryProcessed) || 0} telemetry batch(es).`,
    actor: toWorkerActor(normalizedWorkerId),
    metadata: {
      runId: normalizedRunId,
      campusId: normalizedCampusId,
      telemetryClaimed: Math.max(0, Number(telemetryClaimed) || 0),
      telemetryProcessed: Math.max(0, Number(telemetryProcessed) || 0),
      telemetryDiscarded: Math.max(0, Number(telemetryDiscarded) || 0),
      candidatesCreated: Math.max(0, Number(candidatesCreated) || 0),
      candidatesUpdated: Math.max(0, Number(candidatesUpdated) || 0),
      overlaysUpdated: Math.max(0, Number(overlaysUpdated) || 0),
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    },
  });
};
