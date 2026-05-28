import { Router } from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import {
  deleteAdminFellowshipBrand,
  getAdminLocation,
  getAdminFellowshipBrand,
  getAdminFellowshipBrands,
  getAdminLocations,
  uploadAdminFellowshipBrand,
  updateAdminLocation,
} from '../controllers/adminLocationController.js';

const router = Router();

router.use(authMiddleware);
router.get('/', getAdminLocations);
router.get('/fellowship-brands', getAdminFellowshipBrands);
router.get('/fellowship-brands/:code', getAdminFellowshipBrand);
router.post('/fellowship-brands/:code/logo', uploadAdminFellowshipBrand);
router.delete('/fellowship-brands/:code/logo', deleteAdminFellowshipBrand);
router.get('/:locationId', getAdminLocation);
router.put('/:locationId', updateAdminLocation);

export default router;
