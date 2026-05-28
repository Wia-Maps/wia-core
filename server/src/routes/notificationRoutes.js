import { Router } from 'express';
import {
  deleteNotificationSubscription,
  getNotificationConfig,
  getNotificationEvents,
  upsertNotificationSubscription,
} from '../controllers/notificationController.js';
import { publicDataLimiter } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.get('/config', publicDataLimiter, getNotificationConfig);
router.get('/events', publicDataLimiter, getNotificationEvents);
router.put('/subscription', publicDataLimiter, upsertNotificationSubscription);
router.delete('/subscription', publicDataLimiter, deleteNotificationSubscription);

export default router;
