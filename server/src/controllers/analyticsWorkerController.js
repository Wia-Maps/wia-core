import {
  claimTelemetryBatchesForAnalytics,
  completeTelemetryBatchForAnalytics,
  logAnalyticsWorkerRunSummary,
  syncAnalyticsCandidates,
  syncRoutingWeightOverlay,
} from '../services/analyticsWorkerService.js';

const resolveWorkerId = (req) => {
  return typeof req.analyticsWorker?.id === 'string' ? req.analyticsWorker.id : 'default';
};

export const claimAnalyticsTelemetryBatches = async (req, res) => {
  try {
    const data = await claimTelemetryBatchesForAnalytics({
      campusId: req.body?.campusId ?? req.query.campusId,
      limit: req.body?.limit ?? req.query.limit,
      leaseSeconds: req.body?.leaseSeconds ?? req.query.leaseSeconds,
      workerId: resolveWorkerId(req),
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to claim telemetry batches',
    });
  }
};

export const completeAnalyticsTelemetryBatch = async (req, res) => {
  try {
    const data = await completeTelemetryBatchForAnalytics(req.params.batchId, {
      status: req.body?.status,
      metadata: req.body?.metadata,
      workerId: resolveWorkerId(req),
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to complete telemetry batch',
    });
  }
};

export const upsertAnalyticsRouteCandidates = async (req, res) => {
  try {
    const data = await syncAnalyticsCandidates({
      candidates: req.body?.candidates,
      workerId: resolveWorkerId(req),
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to sync analytics route candidates',
    });
  }
};

export const upsertAnalyticsRoutingWeights = async (req, res) => {
  try {
    const data = await syncRoutingWeightOverlay({
      campusId: req.body?.campusId ?? req.body?.campus_id ?? req.query.campusId,
      edges: req.body?.edges,
      metadata: req.body?.metadata,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to sync routing weight overlay',
    });
  }
};

export const createAnalyticsRunSummary = async (req, res) => {
  try {
    const data = await logAnalyticsWorkerRunSummary({
      workerId: resolveWorkerId(req),
      runId: req.body?.runId,
      campusId: req.body?.campusId ?? req.body?.campus_id,
      telemetryClaimed: req.body?.telemetryClaimed,
      telemetryProcessed: req.body?.telemetryProcessed,
      telemetryDiscarded: req.body?.telemetryDiscarded,
      candidatesCreated: req.body?.candidatesCreated,
      candidatesUpdated: req.body?.candidatesUpdated,
      overlaysUpdated: req.body?.overlaysUpdated,
      notes: req.body?.notes,
      metadata: req.body?.metadata,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to log analytics run summary',
    });
  }
};
