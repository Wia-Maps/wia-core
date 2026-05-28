import { Router } from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { getAdminActivity, revertAdminActivityState } from '../controllers/adminActivityController.js';

const router = Router();

router.use(authMiddleware);
router.get('/', getAdminActivity);
router.post('/:activityId/revert', revertAdminActivityState);

export default router;
