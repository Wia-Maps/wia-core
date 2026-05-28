import { Router } from 'express';
import {
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  registerAdmin,
} from '../controllers/authController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { loginLimiter, registerLimiter } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.post('/login', loginLimiter, loginAdmin);
router.post('/register', registerLimiter, registerAdmin);
router.get('/me', authMiddleware, getAdminSession);
router.post('/logout', logoutAdmin);

export default router;
