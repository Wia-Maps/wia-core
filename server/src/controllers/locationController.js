import { listLocationCatalogRecords } from '../services/mapDatasetService.js';
import { listFellowshipBrands } from '../services/fellowshipBrandService.js';

export const getCampusLocations = async (_req, res) => {
  try {
    const locations = await listLocationCatalogRecords();

    return res.status(200).json({
      success: true,
      data: locations,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to load campus locations',
    });
  }
};

export const getPublicFellowshipBrands = async (_req, res) => {
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
