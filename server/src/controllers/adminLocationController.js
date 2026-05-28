import { formatDatasetMutationResponse } from '../services/mapDatasetService.js';
import {
  getFellowshipBrand,
  listFellowshipBrands,
  removeFellowshipBrandLogo,
  uploadFellowshipBrandLogo,
} from '../services/fellowshipBrandService.js';
import {
  getAdminLocationDetail,
  listAdminLocationRows,
  updateAdminLocationMetadata,
} from '../services/adminLocationService.js';

const getActorFromRequest = (req) => ({
  adminId: typeof req.user?.adminId === 'string' ? req.user.adminId : null,
  email: typeof req.user?.email === 'string' ? req.user.email : null,
});

export const getAdminLocations = async (req, res) => {
  try {
    const data = await listAdminLocationRows({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      status: req.query.status,
      category: req.query.category,
      sortBy: req.query.sortBy,
      sortDir: req.query.sortDir,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load admin locations',
    });
  }
};

export const getAdminLocation = async (req, res) => {
  try {
    const data = await getAdminLocationDetail(req.params.locationId);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message || 'Unable to load admin location',
    });
  }
};

export const updateAdminLocation = async (req, res) => {
  try {
    const result = await updateAdminLocationMetadata(
      req.params.locationId,
      req.body,
      getActorFromRequest(req)
    );

    return res.status(200).json({
      success: true,
      data: {
        location: result.location,
        mutation: formatDatasetMutationResponse(result.mutation),
      },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to update admin location',
    });
  }
};

export const getAdminFellowshipBrands = async (_req, res) => {
  try {
    const data = await listFellowshipBrands();

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to load fellowship brands',
    });
  }
};

export const getAdminFellowshipBrand = async (req, res) => {
  try {
    const data = await getFellowshipBrand(req.params.code);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Fellowship brand not found',
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load fellowship brand',
    });
  }
};

export const uploadAdminFellowshipBrand = async (req, res) => {
  try {
    const data = await uploadFellowshipBrandLogo(req.params.code, req.body, getActorFromRequest(req));

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to upload fellowship badge',
    });
  }
};

export const deleteAdminFellowshipBrand = async (req, res) => {
  try {
    const data = await removeFellowshipBrandLogo(req.params.code, getActorFromRequest(req));

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to remove fellowship badge',
    });
  }
};
