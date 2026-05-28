import {
  bulkDeleteDatasetFeatures,
  bulkImportDatasetBundle,
  bulkUpsertDatasetFeatures,
  formatDatasetBundleMutationResponse,
  createFeatureInDataset,
  deleteFeatureFromDataset,
  formatDatasetMutationResponse,
  getDatasetResponse,
  listDatasetRevisions,
  parseDatasetTypeParam,
  restoreDatasetRevision,
  updateFeatureInDataset,
} from '../services/mapDatasetService.js';
import { getRoutingWeightOverlay } from '../services/routingWeightService.js';

const sendDatasetPayload = async (req, res, datasetType) => {
  const dataset = await getDatasetResponse(datasetType);
  const etag = `"${dataset.version}"`;

  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  res.set('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  return res.status(200).json({
    success: true,
    data: dataset,
  });
};

const getActorFromRequest = (req) => ({
  adminId: typeof req.user?.adminId === 'string' ? req.user.adminId : null,
  email: typeof req.user?.email === 'string' ? req.user.email : null,
});

export const getLocationDataset = async (req, res) => {
  try {
    return await sendDatasetPayload(req, res, 'locations');
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to load location dataset',
    });
  }
};

export const getRoutingDataset = async (req, res) => {
  try {
    return await sendDatasetPayload(req, res, 'routing');
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to load routing dataset',
    });
  }
};

export const getRoutingWeightDataset = async (req, res) => {
  try {
    const overlay = await getRoutingWeightOverlay(req.query.campusId);

    return res.status(200).json({
      success: true,
      data: overlay,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to load routing weight overlay',
    });
  }
};

export const getAdminDataset = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const dataset = await getDatasetResponse(datasetType);

    return res.status(200).json({
      success: true,
      data: dataset,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load dataset',
    });
  }
};

export const getAdminDatasetRevisions = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const limit = Number(req.query.limit) || 25;
    const revisions = await listDatasetRevisions(datasetType, limit);

    return res.status(200).json({
      success: true,
      data: revisions,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load dataset revisions',
    });
  }
};

export const createAdminDatasetFeature = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const result = await createFeatureInDataset(datasetType, req.body.feature, getActorFromRequest(req));

    return res.status(201).json({
      success: true,
      data: formatDatasetMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to create feature',
    });
  }
};

export const updateAdminDatasetFeature = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const featureId = decodeURIComponent(req.params.featureId);
    const result = await updateFeatureInDataset(datasetType, featureId, req.body.feature, getActorFromRequest(req));

    return res.status(200).json({
      success: true,
      data: formatDatasetMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to update feature',
    });
  }
};

export const deleteAdminDatasetFeature = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const featureId = decodeURIComponent(req.params.featureId);
    const result = await deleteFeatureFromDataset(datasetType, featureId, getActorFromRequest(req));

    return res.status(200).json({
      success: true,
      data: formatDatasetMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to delete feature',
    });
  }
};

export const bulkUpsertAdminDatasetFeatures = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const result = await bulkUpsertDatasetFeatures(
      datasetType,
      req.body.collection,
      getActorFromRequest(req),
      { importOptions: req.body.importOptions }
    );

    return res.status(200).json({
      success: true,
      data: formatDatasetMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to bulk upsert dataset features',
    });
  }
};

export const bulkImportAdminDatasetBundle = async (req, res) => {
  try {
    const result = await bulkImportDatasetBundle(req.body.bundle, getActorFromRequest(req), {
      importOptions: req.body.importOptions,
    });

    return res.status(200).json({
      success: true,
      data: formatDatasetBundleMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to import dataset bundle',
    });
  }
};

export const bulkDeleteAdminDatasetFeatures = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const result = await bulkDeleteDatasetFeatures(
      datasetType,
      req.body.featureIds,
      getActorFromRequest(req)
    );

    return res.status(200).json({
      success: true,
      data: formatDatasetMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to bulk delete dataset features',
    });
  }
};

export const restoreAdminDatasetRevision = async (req, res) => {
  try {
    const datasetType = parseDatasetTypeParam(req.params.datasetType);
    const revisionId = typeof req.body.revisionId === 'string' ? req.body.revisionId.trim() : '';

    if (!revisionId) {
      return res.status(400).json({
        success: false,
        error: 'revisionId is required',
      });
    }

    const result = await restoreDatasetRevision(datasetType, revisionId, getActorFromRequest(req));

    return res.status(200).json({
      success: true,
      data: formatDatasetMutationResponse(result),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to restore dataset revision',
    });
  }
};
