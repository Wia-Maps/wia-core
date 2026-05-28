import { Router } from 'express';
import {
  getCampusLocations,
  getPublicFellowshipBrands,
} from '../controllers/locationController.js';

const router = Router();

router.get('/fellowship-brands', getPublicFellowshipBrands);
router.get('/', getCampusLocations);

export default router;
