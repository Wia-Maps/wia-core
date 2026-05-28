import { listLocationCatalogRecords } from '../services/mapDatasetService.js';

export const loadLocationCatalog = async () => {
  return listLocationCatalogRecords();
};
