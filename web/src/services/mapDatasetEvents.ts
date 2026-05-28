import type { MapDatasetRecord, MapFeatureCollection } from './mapDatasets';

export const MAP_DATASET_UPDATED_EVENT = 'wia:map-dataset-updated';

export type MapDatasetUpdatedDetail<TCollection = MapFeatureCollection> = MapDatasetRecord<TCollection>;

export const publishMapDatasetUpdated = (dataset: MapDatasetUpdatedDetail): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<MapDatasetUpdatedDetail>(MAP_DATASET_UPDATED_EVENT, {
      detail: dataset,
    })
  );
};
