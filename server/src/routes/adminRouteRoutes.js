import { Router } from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import {
  approveAdminRouteCandidate,
  deleteAdminRouteRecordingDraft,
  getAdminRouteCandidate,
  getAdminRouteCandidates,
  rejectAdminRouteCandidate,
  saveAdminRouteRecordingDraft,
  submitAdminRouteRecording,
  updateAdminRouteCandidate,
} from '../controllers/routeController.js';

const router = Router();

router.use(authMiddleware);

router.get('/candidates', getAdminRouteCandidates);
router.get('/candidates/:candidateId', getAdminRouteCandidate);
router.put('/candidates/:candidateId', updateAdminRouteCandidate);
router.post('/candidates/:candidateId/approve', approveAdminRouteCandidate);
router.post('/candidates/:candidateId/reject', rejectAdminRouteCandidate);
router.post('/recordings/drafts', saveAdminRouteRecordingDraft);
router.delete('/recordings/drafts/:draftId', deleteAdminRouteRecordingDraft);
router.post('/recordings/submit', submitAdminRouteRecording);

export default router;
