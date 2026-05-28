import { Router } from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import {
  bulkDeleteAdminDatasetFeatures,
  bulkImportAdminDatasetBundle,
  bulkUpsertAdminDatasetFeatures,
  createAdminDatasetFeature,
  deleteAdminDatasetFeature,
  getAdminDataset,
  getAdminDatasetRevisions,
  getLocationDataset,
  getRoutingDataset,
  getRoutingWeightDataset,
  restoreAdminDatasetRevision,
  updateAdminDatasetFeature,
} from '../controllers/mapDataController.js';
import {
  createLiveShareSession,
  resolveLiveShareSession,
} from '../controllers/liveShareController.js';
import { mapDataLimiter, publicDataLimiter, bulkOperationLimiter } from '../middleware/rateLimitMiddleware.js';

export const publicMapRouter = Router();
publicMapRouter.get('/geojson', mapDataLimiter, getLocationDataset);
publicMapRouter.get('/routing', mapDataLimiter, getRoutingDataset);
publicMapRouter.get('/routing-weights', mapDataLimiter, getRoutingWeightDataset);
publicMapRouter.post('/live-share/session', publicDataLimiter, createLiveShareSession);
publicMapRouter.post('/live-share/resolve', publicDataLimiter, resolveLiveShareSession);

export const adminMapRouter = Router();
adminMapRouter.use(authMiddleware);
adminMapRouter.post('/bundle-import', bulkOperationLimiter, bulkImportAdminDatasetBundle);
adminMapRouter.get('/:datasetType', getAdminDataset);
adminMapRouter.get('/:datasetType/revisions', getAdminDatasetRevisions);
adminMapRouter.post('/:datasetType/features', createAdminDatasetFeature);
adminMapRouter.put('/:datasetType/features/:featureId', updateAdminDatasetFeature);
adminMapRouter.delete('/:datasetType/features/:featureId', deleteAdminDatasetFeature);
adminMapRouter.post('/:datasetType/bulk-upsert', bulkOperationLimiter, bulkUpsertAdminDatasetFeatures);
adminMapRouter.post('/:datasetType/bulk-delete', bulkOperationLimiter, bulkDeleteAdminDatasetFeatures);
adminMapRouter.post('/:datasetType/restore', bulkOperationLimiter, restoreAdminDatasetRevision);
