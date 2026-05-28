import { Router } from 'express';
import {
  claimAnalyticsTelemetryBatches,
  completeAnalyticsTelemetryBatch,
  createAnalyticsRunSummary,
  upsertAnalyticsRouteCandidates,
  upsertAnalyticsRoutingWeights,
} from '../controllers/analyticsWorkerController.js';
import analyticsWorkerMiddleware from '../middleware/analyticsWorkerMiddleware.js';
import { analyticsWorkerLimiter } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.use(analyticsWorkerLimiter);
router.use(analyticsWorkerMiddleware);

router.post('/telemetry/claim', claimAnalyticsTelemetryBatches);
router.post('/telemetry/:batchId/complete', completeAnalyticsTelemetryBatch);
router.post('/candidates/upsert', upsertAnalyticsRouteCandidates);
router.post('/routing-weights', upsertAnalyticsRoutingWeights);
router.post('/runs/summary', createAnalyticsRunSummary);

export default router;
