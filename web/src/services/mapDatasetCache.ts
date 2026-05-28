import type { MapDatasetRecord, MapDatasetType, MapFeatureCollection } from './mapDatasets';
import { clientConfig } from '../config/client';

const DATABASE_NAME = 'wia-map-datasets';
const DATABASE_VERSION = 1;
const DATASET_STORE = 'datasets';

export interface CachedMapDatasetRecord<TCollection = MapFeatureCollection>
  extends MapDatasetRecord<TCollection> {
  cachedAt: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

const isMapDatasetPersistenceEnabled = (): boolean => {
  return clientConfig.offline.enabled && clientConfig.offline.persistence;
};

const openDatabase = (): Promise<IDBDatabase> => {
  if (!isMapDatasetPersistenceEnabled()) {
    return Promise.reject(new Error('Map dataset persistence is disabled.'));
  }

  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }

    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATASET_STORE)) {
        database.createObjectStore(DATASET_STORE, { keyPath: 'datasetType' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });

  return databasePromise;
};

const withStore = async <T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(DATASET_STORE, mode);
    const store = transaction.objectStore(DATASET_STORE);
    const request = callback(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
};

export const readCachedMapDataset = async <TCollection = MapFeatureCollection>(
  datasetType: MapDatasetType
): Promise<CachedMapDatasetRecord<TCollection> | null> => {
  if (!isMapDatasetPersistenceEnabled()) {
    return null;
  }

  try {
    return await withStore<CachedMapDatasetRecord<TCollection> | null>('readonly', (store) =>
      store.get(datasetType)
    );
  } catch {
    return null;
  }
};

export const writeCachedMapDataset = async <TCollection = MapFeatureCollection>(
  dataset: MapDatasetRecord<TCollection>
): Promise<void> => {
  if (!isMapDatasetPersistenceEnabled()) {
    return;
  }

  try {
    await withStore<IDBValidKey>('readwrite', (store) =>
      store.put({
        ...dataset,
        cachedAt: Date.now(),
      })
    );
  } catch {
    // Ignore cache persistence failures.
  }
};
