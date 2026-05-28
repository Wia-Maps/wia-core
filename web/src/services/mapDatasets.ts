import type { FeatureCollection, Geometry } from 'geojson';
import { toApiUrl } from '../config/api';

export type MapDatasetType = 'locations' | 'routing';

export interface MapFeatureProperties {
  [key: string]: unknown;
}

export type MapFeatureCollection = FeatureCollection<Geometry, MapFeatureProperties>;

export interface MapDatasetRecord<TCollection = MapFeatureCollection> {
  datasetType: MapDatasetType;
  revisionId: string;
  version: string;
  updatedAt: string;
  collection: TCollection;
}

export interface MapDatasetRevisionRecord {
  id: string;
  datasetType: MapDatasetType;
  version: string;
  featureCount: number;
  changeType: string;
  changeSummary: string;
  actor: {
    adminId: string | null;
    email: string | null;
  } | null;
  sourceRevisionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MapDatasetMutationRecord<TCollection = MapFeatureCollection> {
  dataset: MapDatasetRecord<TCollection>;
  revision: MapDatasetRevisionRecord;
  warnings: string[];
}

export interface MapDatasetImportOptions {
  typeSourceProperty?: string | null;
  typeFallback?: string;
}

export interface MapDatasetBundleInput<TCollection = MapFeatureCollection> {
  type: 'wia-dataset-bundle';
  version?: number;
  locations: TCollection;
  routing: TCollection;
}

export interface MapDatasetBundleMutationRecord<TCollection = MapFeatureCollection> {
  locations: MapDatasetMutationRecord<TCollection>;
  routing: MapDatasetMutationRecord<TCollection>;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const resolvePublicDatasetPath = (datasetType: MapDatasetType): string => {
  return datasetType === 'locations' ? '/map/geojson' : '/map/routing';
};

const resolveAdminDatasetPath = (datasetType: MapDatasetType): string => {
  return `/admin/map/${datasetType}`;
};

const readJsonResponse = async <T>(response: Response): Promise<T | null> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  return (await response.json()) as T;
};

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const payload = await readJsonResponse<ApiEnvelope<T>>(response);

  if (!response.ok || !payload?.success || typeof payload.data === 'undefined') {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return payload.data;
};

export const fetchPublicMapDataset = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType
): Promise<MapDatasetRecord<TCollection>> => {
  return requestJson<MapDatasetRecord<TCollection>>(toApiUrl(resolvePublicDatasetPath(datasetType)), {
    method: 'GET',
  });
};

export const fetchAdminMapDataset = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType
): Promise<MapDatasetRecord<TCollection>> => {
  return requestJson<MapDatasetRecord<TCollection>>(toApiUrl(resolveAdminDatasetPath(datasetType)), {
    method: 'GET',
  });
};

export const fetchAdminMapDatasetRevisions = async (
  datasetType: MapDatasetType,
  limit = 20
): Promise<MapDatasetRevisionRecord[]> => {
  return requestJson<MapDatasetRevisionRecord[]>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/revisions?limit=${encodeURIComponent(String(limit))}`),
    {
      method: 'GET',
    }
  );
};

export const createAdminMapFeature = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType,
  feature: unknown
): Promise<MapDatasetMutationRecord<TCollection>> => {
  return requestJson<MapDatasetMutationRecord<TCollection>>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/features`),
    {
      method: 'POST',
      body: JSON.stringify({ feature }),
    }
  );
};

export const updateAdminMapFeature = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType,
  featureId: string,
  feature: unknown
): Promise<MapDatasetMutationRecord<TCollection>> => {
  return requestJson<MapDatasetMutationRecord<TCollection>>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/features/${encodeURIComponent(featureId)}`),
    {
      method: 'PUT',
      body: JSON.stringify({ feature }),
    }
  );
};

export const deleteAdminMapFeature = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType,
  featureId: string
): Promise<MapDatasetMutationRecord<TCollection>> => {
  return requestJson<MapDatasetMutationRecord<TCollection>>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/features/${encodeURIComponent(featureId)}`),
    {
      method: 'DELETE',
    }
  );
};

export const bulkUpsertAdminMapDataset = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType,
  collection: unknown,
  importOptions?: MapDatasetImportOptions | null
): Promise<MapDatasetMutationRecord<TCollection>> => {
  return requestJson<MapDatasetMutationRecord<TCollection>>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/bulk-upsert`),
    {
      method: 'POST',
      body: JSON.stringify({ collection, importOptions: importOptions ?? undefined }),
    }
  );
};

export const bulkDeleteAdminMapDatasetFeatures = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType,
  featureIds: string[]
): Promise<MapDatasetMutationRecord<TCollection>> => {
  return requestJson<MapDatasetMutationRecord<TCollection>>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/bulk-delete`),
    {
      method: 'POST',
      body: JSON.stringify({ featureIds }),
    }
  );
};

export const restoreAdminMapDatasetRevision = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType,
  revisionId: string
): Promise<MapDatasetMutationRecord<TCollection>> => {
  return requestJson<MapDatasetMutationRecord<TCollection>>(
    toApiUrl(`${resolveAdminDatasetPath(datasetType)}/restore`),
    {
      method: 'POST',
      body: JSON.stringify({ revisionId }),
    }
  );
};

export const bulkImportAdminMapBundle = async <TCollection = MapFeatureCollection>(
  bundle: unknown,
  importOptions?: MapDatasetImportOptions | null
): Promise<MapDatasetBundleMutationRecord<TCollection>> => {
  return requestJson<MapDatasetBundleMutationRecord<TCollection>>(
    toApiUrl('/admin/map/bundle-import'),
    {
      method: 'POST',
      body: JSON.stringify({ bundle, importOptions: importOptions ?? undefined }),
    }
  );
};

export const bulkUpsertMixedAdminMapDataset = bulkImportAdminMapBundle;
