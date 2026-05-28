import { Router } from 'express';
import {
  getLocationPowerStatus,
  getRecentPowerReports,
  reportPowerStatus,
} from '../controllers/powerController.js';
import { publicDataLimiter, powerReportLimiter } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.get('/recent', publicDataLimiter, getRecentPowerReports);
router.get('/:locationId', publicDataLimiter, getLocationPowerStatus);
router.post('/report', powerReportLimiter, reportPowerStatus);

export default router;
