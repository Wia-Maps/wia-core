import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import HomePage from './components/HomePage';
import LocationInfoCard from './components/LocationInfoCard';
import { AdminShell } from './components/admin/AdminShell';
import type { AdminRoute } from './components/admin/adminWorkspace';
import type { LoadState } from './core/loadState';
import FavouriteNotificationEventLayer from './core/FavouriteNotificationEventLayer';
import FavouriteNotificationMessageLayer from './core/FavouriteNotificationMessageLayer';
import FavouriteNotificationSyncLayer from './core/FavouriteNotificationSyncLayer';
import { useToast } from './context/ToastContext';
import { runtimeRoutingClient } from './core/runtimeRoutingClient';
import { fetchPublicFellowshipBrands } from './services/fellowshipBrands';
import { FELLOWSHIP_BRANDS_UPDATED_EVENT } from './services/fellowshipBrandEvents';
import { readCachedMapDataset, writeCachedMapDataset } from './services/mapDatasetCache';
import { MAP_DATASET_UPDATED_EVENT } from './services/mapDatasetEvents';
import type { MapDatasetRecord } from './services/mapDatasets';
import { fetchPublicMapDataset } from './services/mapDatasets';
import {
  fetchPublicRoutingWeightOverlay,
  readCachedRoutingWeightOverlay,
  ROUTING_WEIGHT_OVERLAY_UPDATED_EVENT,
  type RoutingWeightOverlayRecord,
  writeCachedRoutingWeightOverlay,
} from './services/routingWeights';
import { useAppStore } from './store/useAppStore';
import { clientConfig } from './config/client';
import { resolveFeatureAnchorCoordinates, resolveFeatureId } from './core/geoGeometry';
import type { MapEngineAdapter } from './core/mapEngineTypes';

interface FeatureProperties {
  [key: string]: unknown;
}

type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;

const ADMIN_DASHBOARD_PATH = '/admin';
const ADMIN_LOCATIONS_PATH = '/admin/locations';
const ADMIN_POWER_PATH = '/admin/power';
const ADMIN_ROUTES_PATH = '/admin/routes';
const ADMIN_DATASETS_PATH = '/admin/datasets';
const ADMIN_ACTIVITY_PATH = '/admin/activity';
const ADMIN_SETTINGS_PATH = '/admin/settings';
const MAP_PATH = '/map';

const normalizePath = (value: string): string => {
  if (!value) {
    return '/';
  }

  const normalized = value.replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : '/';
};

const resolveAdminRoute = (value: string): AdminRoute | null => {
  const normalized = normalizePath(value);

  if (normalized === ADMIN_DASHBOARD_PATH) {
    return 'dashboard';
  }

  if (normalized === ADMIN_LOCATIONS_PATH) {
    return 'locations';
  }

  if (normalized === ADMIN_POWER_PATH) {
    return 'power';
  }

  if (normalized === ADMIN_ROUTES_PATH) {
    return 'routes';
  }

  if (normalized === ADMIN_DATASETS_PATH) {
    return 'datasets';
  }

  if (normalized === ADMIN_ACTIVITY_PATH) {
    return 'activity';
  }

  if (normalized === ADMIN_SETTINGS_PATH) {
    return 'settings';
  }

  return null;
};

export interface MapAppProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export default function MapApp({ currentPath, onNavigate }: MapAppProps): JSX.Element {
  const [geojsonData, setGeojsonData] = useState<CampusCollection | null>(null);
  const [locationsState, setLocationsState] = useState<LoadState>('idle');
  const [fellowshipBrandsLoaded, setFellowshipBrandsLoaded] = useState(false);
  const [routingDataset, setRoutingDataset] = useState<MapDatasetRecord<CampusCollection> | null>(null);
  const [routingDatasetSourceLabel, setRoutingDatasetSourceLabel] = useState('backend');
  const [routingWeightOverlay, setRoutingWeightOverlay] = useState<RoutingWeightOverlayRecord | null>(null);
  const [routingState, setRoutingState] = useState<LoadState>('idle');
  const [routingRuntimeAvailable, setRoutingRuntimeAvailable] = useState(false);
  const [mapInstance, setMapInstance] = useState<MapEngineAdapter | null>(null);
  const serviceWorkerRegisteredRef = useRef(false);
  const latestRoutingPrepareRequestIdRef = useRef(0);

  const { setOnline, selectedLocation, deselectLocation, refreshSelectedLocation, setFellowshipBrands } = useAppStore();
  const { showError, showWarning } = useToast();
  const adminRoute = resolveAdminRoute(currentPath);
  const adminPageVisible = adminRoute !== null;

  const navigateToAdminPage = useCallback((): void => {
    onNavigate(ADMIN_DASHBOARD_PATH);
  }, [onNavigate]);

  const navigateToAdminRoute = useCallback((route: AdminRoute): void => {
    if (route === 'locations') {
      onNavigate(ADMIN_LOCATIONS_PATH);
      return;
    }

    if (route === 'power') {
      onNavigate(ADMIN_POWER_PATH);
      return;
    }

    if (route === 'routes') {
      onNavigate(ADMIN_ROUTES_PATH);
      return;
    }

    if (route === 'datasets') {
      onNavigate(ADMIN_DATASETS_PATH);
      return;
    }

    if (route === 'activity') {
      onNavigate(ADMIN_ACTIVITY_PATH);
      return;
    }

    if (route === 'settings') {
      onNavigate(ADMIN_SETTINGS_PATH);
      return;
    }

    onNavigate(ADMIN_DASHBOARD_PATH);
  }, [onNavigate]);

  const navigateToMapPage = useCallback((): void => {
    onNavigate(MAP_PATH);
  }, [onNavigate]);

  const applyPreparedRoutingResult = useCallback((sourceLabel: string, result: {
    kind: 'graph' | 'empty' | 'invalid';
    warnings: string[];
    errors: string[];
  }): void => {
    if (result.warnings.length > 0) {
      console.warn(`Routing graph warnings (${sourceLabel}):`, result.warnings);
    }

    if (result.errors.length > 0) {
      console.error(`Routing graph errors (${sourceLabel}):`, result.errors);
    }
  }, []);

  useEffect((): void => {
    if (adminPageVisible || locationsState !== 'idle') {
      return;
    }

    setLocationsState('loading');

    const loadGeoJSON = async (): Promise<void> => {
      try {
        const dataset = await fetchPublicMapDataset<CampusCollection>('locations');
        setGeojsonData(dataset.collection);
        await writeCachedMapDataset(dataset);
        setLocationsState('ready');
      } catch (error) {
        const cached = await readCachedMapDataset<CampusCollection>('locations');
        if (cached) {
          setGeojsonData(cached.collection);
          setLocationsState('ready');
          return;
        }

        console.error('Error loading GeoJSON:', error);
        showError('Unable to load campus map data right now.', {
          title: 'Map data',
          dedupeKey: 'geojson-load',
        });
        setLocationsState('error');
      }
    };

    void loadGeoJSON();
  }, [adminPageVisible, locationsState, showError]);

  useEffect((): void => {
    if (adminPageVisible || routingState !== 'idle') {
      return;
    }

    setRoutingState('loading');

    const loadRoutingGraph = async (): Promise<void> => {
      try {
        const [dataset, overlay] = await Promise.all([
          fetchPublicMapDataset<CampusCollection>('routing'),
          fetchPublicRoutingWeightOverlay(clientConfig.campus_id).catch(() => null),
        ]);
        setRoutingDataset(dataset);
        setRoutingDatasetSourceLabel('backend');
        setRoutingWeightOverlay(overlay);
        await writeCachedMapDataset(dataset);
        if (overlay) {
          writeCachedRoutingWeightOverlay(overlay);
        }
        setRoutingState('processing');
        return;
      } catch (error) {
        console.warn('Routing graph load failed for backend source:', error);
      }

      const [cached, cachedOverlay] = await Promise.all([
        readCachedMapDataset<CampusCollection>('routing'),
        Promise.resolve(readCachedRoutingWeightOverlay(clientConfig.campus_id)),
      ]);
      if (cached) {
        setRoutingDataset(cached);
        setRoutingDatasetSourceLabel('cache');
        setRoutingWeightOverlay(cachedOverlay);
        setRoutingState('processing');
        return;
      }

      console.warn('No valid routing graph found. Falling back to direct routing.');
      setRoutingState('error');
    };

    void loadRoutingGraph();
  }, [adminPageVisible, routingState]);

  useEffect(() => {
    if (adminPageVisible || !routingDataset) {
      return;
    }

    latestRoutingPrepareRequestIdRef.current += 1;
    const requestId = latestRoutingPrepareRequestIdRef.current;

    startTransition(() => {
      setRoutingState('processing');
    });

    void runtimeRoutingClient.prepareRuntime({
      sourceLabel: routingDatasetSourceLabel,
      datasetVersion: routingDataset.version,
      routingDataset: routingDataset.collection,
      locations: geojsonData,
      overlay: (routingWeightOverlay?.edges ?? []).map((entry) => ({
        edgeId: entry.edgeId,
        effectiveWeightM: entry.effectiveWeightM,
      })),
    })
      .then((result) => {
        if (requestId !== latestRoutingPrepareRequestIdRef.current) {
          return;
        }

        applyPreparedRoutingResult(result.sourceLabel, result);
        startTransition(() => {
          setRoutingRuntimeAvailable((current) => current || result.kind !== 'invalid');
          setRoutingState(result.kind === 'invalid' ? 'error' : 'ready');
        });

        if (result.kind === 'invalid') {
          console.warn('Routing graph invalid - using direct routing fallback');
        }
      })
      .catch((error) => {
        if (requestId !== latestRoutingPrepareRequestIdRef.current) {
          return;
        }

        console.warn('Routing runtime preparation failed:', error);
        startTransition(() => {
          setRoutingState('error');
        });
      });
  }, [
    adminPageVisible,
    applyPreparedRoutingResult,
    geojsonData,
    routingDataset,
    routingDatasetSourceLabel,
    routingWeightOverlay,
  ]);

  useEffect(() => {
    if (fellowshipBrandsLoaded) {
      return;
    }

    let cancelled = false;

    const loadFellowshipBrands = async (): Promise<void> => {
      try {
        const brands = await fetchPublicFellowshipBrands();

        if (cancelled) {
          return;
        }

        setFellowshipBrands(brands);
      } catch (error) {
        if (!cancelled) {
          console.warn('Unable to load fellowship brands:', error);
        }
      } finally {
        if (!cancelled) {
          setFellowshipBrandsLoaded(true);
        }
      }
    };

    void loadFellowshipBrands();

    return () => {
      cancelled = true;
    };
  }, [fellowshipBrandsLoaded, setFellowshipBrands]);

  useEffect((): (() => void) => {
    const handleDatasetUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<MapDatasetRecord<CampusCollection>>).detail;

      if (!detail) {
        return;
      }

      if (detail.datasetType === 'locations') {
        setGeojsonData(detail.collection);
        setLocationsState('ready');

        if (selectedLocation) {
          const selectedFeature = detail.collection.features.find(
            (feature, index) => resolveFeatureId(feature, index) === selectedLocation.id
          );

          if (!selectedFeature) {
            deselectLocation();
          } else {
            refreshSelectedLocation({
              id: selectedLocation.id,
              name:
                typeof selectedFeature.properties?.name === 'string'
                  ? selectedFeature.properties.name
                  : selectedLocation.name,
              type:
                typeof selectedFeature.properties?.type === 'string'
                  ? selectedFeature.properties.type
                  : selectedLocation.type,
              coordinates: resolveFeatureAnchorCoordinates(selectedFeature),
              properties: { ...(selectedFeature.properties ?? {}) },
              fellowshipFocusCode: selectedLocation.fellowshipFocusCode ?? null,
              fellowshipServiceFocusKey: selectedLocation.fellowshipServiceFocusKey ?? null,
            });
          }
        }

        return;
      }

      setRoutingDataset(detail);
      setRoutingDatasetSourceLabel('live');
      setRoutingState('processing');
    };

    window.addEventListener(MAP_DATASET_UPDATED_EVENT, handleDatasetUpdated);

    return (): void => {
      window.removeEventListener(MAP_DATASET_UPDATED_EVENT, handleDatasetUpdated);
    };
  }, [deselectLocation, refreshSelectedLocation, selectedLocation]);

  useEffect((): (() => void) => {
    const handleOverlayUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<RoutingWeightOverlayRecord>).detail;
      if (!detail) {
        return;
      }

      setRoutingWeightOverlay(detail);
      writeCachedRoutingWeightOverlay(detail);
      if (routingDataset) {
        setRoutingState('processing');
      }
    };

    window.addEventListener(ROUTING_WEIGHT_OVERLAY_UPDATED_EVENT, handleOverlayUpdated);

    return (): void => {
      window.removeEventListener(ROUTING_WEIGHT_OVERLAY_UPDATED_EVENT, handleOverlayUpdated);
    };
  }, [routingDataset]);

  useEffect((): (() => void) => {
    const handleFellowshipBrandsUpdated = (): void => {
      void fetchPublicFellowshipBrands()
        .then((brands) => {
          setFellowshipBrands(brands);
          setFellowshipBrandsLoaded(true);
        })
        .catch((error) => {
          console.warn('Unable to refresh fellowship brands:', error);
        });
    };

    window.addEventListener(FELLOWSHIP_BRANDS_UPDATED_EVENT, handleFellowshipBrandsUpdated);

    return (): void => {
      window.removeEventListener(FELLOWSHIP_BRANDS_UPDATED_EVENT, handleFellowshipBrandsUpdated);
    };
  }, [setFellowshipBrands]);

  useEffect((): (() => void) => {
    if (!clientConfig.offline.enabled) {
      setOnline(true);
      return () => undefined;
    }

    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    setOnline(navigator.onLine);

    return (): void => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  useEffect(() => {
    if (!clientConfig.offline.enabled || serviceWorkerRegisteredRef.current || !mapInstance) {
      return;
    }

    if (!('serviceWorker' in navigator)) {
      return;
    }

    serviceWorkerRegisteredRef.current = true;

    let cancelled = false;

    const scheduleIdle = (
      callback: () => void,
      options: IdleRequestOptions | undefined,
      fallbackDelayMs: number
    ): number => {
      if (typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(() => callback(), options);
      }

      return window.setTimeout(callback, fallbackDelayMs);
    };

    const cancelIdle = (id: number): void => {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(id);
        return;
      }

      window.clearTimeout(id);
    };

    const deferHandle = scheduleIdle(() => {
      if (cancelled) {
        return;
      }

      void navigator.serviceWorker
        .register('/service-worker.js', { scope: '/' })
        .then((registration) => {
          if (registration.waiting) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }

          return registration.update().catch(() => undefined);
        })
        .then(() => {
          if (cancelled) {
            return;
          }

          const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
            .connection;
          const effectiveType = connection?.effectiveType ?? null;

          const shouldPrewarm =
            connection?.saveData !== true &&
            effectiveType !== 'slow-2g' &&
            effectiveType !== '2g';

          if (!shouldPrewarm) {
            return;
          }

          scheduleIdle(() => {
            if (cancelled) {
              return;
            }

            void navigator.serviceWorker.ready.then((registration) => {
              registration.active?.postMessage({ type: 'PREWARM_TILES' });
            });
          }, { timeout: 18000 }, 9000);
        })
        .catch((error) => {
          console.warn('Service Worker registration failed:', error);
          showWarning('Offline support could not be enabled on this device.', {
            title: 'Offline support',
            dedupeKey: 'service-worker',
          });
        });
    }, { timeout: 9000 }, 3500);

    return () => {
      cancelled = true;
      cancelIdle(deferHandle);
    };
  }, [mapInstance, showWarning]);

  useEffect((): (() => void) => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }

      const usesAdminShortcut = event.ctrlKey && event.shiftKey && event.code === 'Digit1';

      if (!usesAdminShortcut) {
        return;
      }

      event.preventDefault();
      navigateToAdminPage();
    };

    window.addEventListener('keydown', handleKeyDown);

    return (): void => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [navigateToAdminPage]);

  return (
    <>
      <FavouriteNotificationMessageLayer />
      <FavouriteNotificationEventLayer />
      <FavouriteNotificationSyncLayer />

      {adminPageVisible ? (
        <AdminShell route={adminRoute ?? 'dashboard'} onNavigate={navigateToAdminRoute} onClose={navigateToMapPage} />
      ) : (
        <>
          <HomePage
            geojsonData={geojsonData}
            routingData={routingDataset?.collection ?? null}
            locationsState={locationsState}
            routingState={routingState}
            routingRuntimeAvailable={routingRuntimeAvailable}
            mapInstance={mapInstance}
            onMapReady={setMapInstance}
          />
          {selectedLocation && (
            <LocationInfoCard routingState={routingState} geojsonData={geojsonData} mapInstance={mapInstance} />
          )}
        </>
      )}
    </>
  );
}
