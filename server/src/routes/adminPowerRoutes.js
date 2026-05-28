import { Router } from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import {
  bulkReportPowerStatus,
  cancelAdminPowerSchedule,
  createAdminPowerSchedule,
  getAdminPowerSchedules,
  updateAdminPowerLocationLock,
} from '../controllers/adminPowerController.js';
import { bulkOperationLimiter, powerControlLimiter } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.use(authMiddleware);
router.post('/bulk-report', bulkOperationLimiter, bulkReportPowerStatus);
router.post('/location-lock', bulkOperationLimiter, updateAdminPowerLocationLock);
router.get('/schedules', getAdminPowerSchedules);
router.post('/schedules', powerControlLimiter, createAdminPowerSchedule);
router.post('/schedules/:scheduleId/cancel', powerControlLimiter, cancelAdminPowerSchedule);

export default router;
