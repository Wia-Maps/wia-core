import { Router } from 'express';
import { postRouteTelemetryBatch } from '../controllers/routeController.js';
import { telemetryLimiter } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.post('/routes', telemetryLimiter, postRouteTelemetryBatch);

export default router;
