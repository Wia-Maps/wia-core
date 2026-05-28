import { useCallback, useEffect, useRef } from 'react';
import type { FeatureCollection, Point } from 'geojson';
import maplibregl, {
  AttributionControl,
  LngLatBounds,
  Popup,
  ScaleControl,
  type GeoJSONSource,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { clientConfig } from '../config/client';
import { publishToast } from '../context/ToastContext';
import {
  endRouteTelemetrySession,
  ensureRouteTelemetrySession,
  installRouteTelemetryOnlineHandler,
  recordRouteTelemetryPoint,
} from '../services/routeTelemetry';
import { useAppStore } from '../store/useAppStore';
import { gpsStatusFromErrorCode, toGpsPermissionState } from './gpsStatus';
import type { MapEngineAdapter, MapViewMode } from './mapEngineTypes';
import { haversineDistanceMeters } from './mapMetrics';
import { buildMapStyle } from './mapStyle';
import { NavigationSensorRuntime } from './navigation/runtime';
import type { NavigationPose } from './navigation/types';

interface MapEngineProps {
  onMapReady?: (map: MapEngineAdapter | null) => void;
  height?: string;
  viewMode?: MapViewMode;
}

const USER_ACCURACY_SOURCE_ID = 'wia-user-accuracy';
const USER_ACCURACY_FILL_LAYER_ID = 'wia-user-accuracy-fill';
const USER_ACCURACY_LINE_LAYER_ID = 'wia-user-accuracy-line';
const USER_LOCATION_SOURCE_ID = 'wia-user-location';
const USER_LOCATION_HALO_LAYER_ID = 'wia-user-location-halo';
const USER_LOCATION_CORE_LAYER_ID = 'wia-user-location-core';
const USER_LOCATION_LAYER_IDS = [
  USER_LOCATION_HALO_LAYER_ID,
  USER_LOCATION_CORE_LAYER_ID,
] as const;
const USER_ACCURACY_LAYER_IDS = [USER_ACCURACY_FILL_LAYER_ID, USER_ACCURACY_LINE_LAYER_ID] as const;
const MOVING_GLOW_HOLD_MS = 3200;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const detectMovement = (
  previousLocation: [number, number] | null,
  currentLocation: [number, number],
  speed: number | null
): boolean => {
  if (typeof speed === 'number' && Number.isFinite(speed) && speed >= 0.35) {
    return true;
  }

  if (!previousLocation) {
    return false;
  }

  return haversineDistanceMeters(previousLocation, currentLocation) >= 0.9;
};

const emptyUserLocationCollection = (): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: [],
});

const buildUserLocationCollection = (
  location: [number, number] | null,
  isMoving = false
): FeatureCollection<Point, { isMoving: boolean }> => ({
  type: 'FeatureCollection',
  features: location
    ? [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [location[1], location[0]],
          },
          properties: {
            isMoving,
          },
        },
      ]
    : [],
});

const setGeoJsonSourceData = (
  map: MapLibreMap,
  sourceId: string,
  data: FeatureCollection<Point>
): void => {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
};

const isTextLabelLayer = (layer: { type?: string; layout?: Record<string, unknown> }): boolean => {
  return layer.type === 'symbol' && Boolean(layer.layout?.['text-field']);
};

const isDefaultVectorLayer = (layer: {
  id?: string;
  type?: string;
  source?: string;
  ['source-layer']?: string;
}): boolean => {
  if (!layer.id || !layer.type) {
    return false;
  }

  if (!['line', 'fill', 'fill-extrusion'].includes(layer.type)) {
    return false;
  }

  const haystack = `${layer.id} ${layer.source ?? ''} ${layer['source-layer'] ?? ''}`.toLowerCase();
  const looksLikeBuilding =
    (layer.type === 'fill' || layer.type === 'fill-extrusion') && haystack.includes('building');
  const looksLikeRoad =
    layer.type === 'line' &&
    /(road|street|highway|path|track|transport|bridge|tunnel|motorway|walkway)/.test(haystack);

  return looksLikeBuilding || looksLikeRoad;
};

const hideDefaultVectorLayers = (map: MapLibreMap): void => {
  const layers = map.getStyle()?.layers ?? [];
  layers.forEach((layer) => {
    if (!isDefaultVectorLayer(layer)) {
      return;
    }

    try {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    } catch {
      // Ignore style layers that do not support layout visibility updates.
    }
  });
};

const getFirstTextLabelLayerId = (map: MapLibreMap): string | undefined => {
  const layers = map.getStyle()?.layers ?? [];
  return layers.find((layer) => isTextLabelLayer(layer))?.id;
};

const moveLayerToTarget = (map: MapLibreMap, layerId: string, beforeId?: string): void => {
  if (!map.getLayer(layerId)) {
    return;
  }

  if (beforeId && map.getLayer(beforeId)) {
    map.moveLayer(layerId, beforeId);
    return;
  }

  map.moveLayer(layerId);
};

const syncUserLocationLayerAlignment = (map: MapLibreMap, _viewMode: MapViewMode): void => {
  const markerAlignment = 'map';
  const markerScale = 'map';

  if (map.getLayer(USER_LOCATION_HALO_LAYER_ID)) {
    map.setPaintProperty(USER_LOCATION_HALO_LAYER_ID, 'circle-pitch-alignment', markerAlignment);
    map.setPaintProperty(USER_LOCATION_HALO_LAYER_ID, 'circle-pitch-scale', markerScale);
  }

  if (map.getLayer(USER_LOCATION_CORE_LAYER_ID)) {
    map.setPaintProperty(USER_LOCATION_CORE_LAYER_ID, 'circle-pitch-alignment', markerAlignment);
    map.setPaintProperty(USER_LOCATION_CORE_LAYER_ID, 'circle-pitch-scale', markerScale);
  }

};

const syncUserLocationLayerPlacement = (map: MapLibreMap): void => {
  const labelLayerId = getFirstTextLabelLayerId(map);
  const overlayAnchorId = labelLayerId;

  USER_ACCURACY_LAYER_IDS.forEach((layerId) => {
    moveLayerToTarget(map, layerId, overlayAnchorId);
  });

  USER_LOCATION_LAYER_IDS.forEach((layerId) => {
    moveLayerToTarget(map, layerId, overlayAnchorId);
  });
};

const resolveReducedViewMode = (mode: MapViewMode): MapViewMode => {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;

  return mode === '2_5d' && connection?.saveData !== true && connection?.effectiveType !== '2g'
    ? '2_5d'
    : 'flat';
};

const ensureAccuracySource = (map: MapLibreMap): void => {
  if (!map.getSource(USER_ACCURACY_SOURCE_ID)) {
    map.addSource(USER_ACCURACY_SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
  }

  if (!map.getLayer(USER_ACCURACY_FILL_LAYER_ID)) {
    map.addLayer({
      id: USER_ACCURACY_FILL_LAYER_ID,
        type: 'fill',
        source: USER_ACCURACY_SOURCE_ID,
        paint: {
          'fill-color': '#38bdf8',
          'fill-opacity': 0.24,
        },
      });
    }

  if (!map.getLayer(USER_ACCURACY_LINE_LAYER_ID)) {
    map.addLayer({
      id: USER_ACCURACY_LINE_LAYER_ID,
      type: 'line',
        source: USER_ACCURACY_SOURCE_ID,
        paint: {
          'line-color': '#0ea5e9',
          'line-opacity': 0.95,
          'line-width': 3.5,
        },
      });
    }
};

const ensureUserLocationSource = (map: MapLibreMap): void => {
  if (!map.getSource(USER_LOCATION_SOURCE_ID)) {
    map.addSource(USER_LOCATION_SOURCE_ID, {
      type: 'geojson',
      data: emptyUserLocationCollection(),
    });
  }

  if (!map.getLayer(USER_LOCATION_HALO_LAYER_ID)) {
    map.addLayer({
      id: USER_LOCATION_HALO_LAYER_ID,
      type: 'circle',
      source: USER_LOCATION_SOURCE_ID,
      paint: {
        'circle-color': '#38bdf8',
        'circle-opacity': ['case', ['boolean', ['get', 'isMoving'], false], 0.42, 0.24],
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          ['case', ['boolean', ['get', 'isMoving'], false], 19, 13],
          17,
          ['case', ['boolean', ['get', 'isMoving'], false], 26, 18],
          20,
          ['case', ['boolean', ['get', 'isMoving'], false], 32, 22],
        ],
        'circle-stroke-color': '#f0f9ff',
        'circle-stroke-opacity': ['case', ['boolean', ['get', 'isMoving'], false], 1, 0.72],
        'circle-stroke-width': ['case', ['boolean', ['get', 'isMoving'], false], 3, 2.2],
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    });
  }

  if (!map.getLayer(USER_LOCATION_CORE_LAYER_ID)) {
    map.addLayer({
      id: USER_LOCATION_CORE_LAYER_ID,
      type: 'circle',
      source: USER_LOCATION_SOURCE_ID,
        paint: {
          'circle-color': '#0ea5e9',
          'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          5.5,
          17,
          6.5,
          20,
          8.5,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 4,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    });
  }
};

const updateAccuracyCircle = (
  map: MapLibreMap,
  center: [number, number],
  radiusMeters: number
): void => {
  if (!map.isStyleLoaded()) {
    return;
  }

  ensureAccuracySource(map);
  const source = map.getSource(USER_ACCURACY_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) {
    return;
  }

  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: buildCirclePolygon(center, radiusMeters),
        properties: {},
      },
    ],
  });
};

const clearAccuracyCircle = (map: MapLibreMap | null): void => {
  if (!map?.isStyleLoaded()) {
    return;
  }

  const source = map.getSource(USER_ACCURACY_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: 'FeatureCollection',
    features: [],
  });
};

const buildCirclePolygon = (center: [number, number], radiusMeters: number) => {
  const [lat, lng] = center;
  const coordinates: [number, number][] = [];
  const earthRadius = 6378137;
  const latRadians = toRadians(lat);

  for (let index = 0; index <= 64; index += 1) {
    const angle = (index / 64) * Math.PI * 2;
    const dx = radiusMeters * Math.cos(angle);
    const dy = radiusMeters * Math.sin(angle);
    const nextLat = lat + (dy / earthRadius) * (180 / Math.PI);
    const nextLng = lng + (dx / (earthRadius * Math.cos(latRadians))) * (180 / Math.PI);
    coordinates.push([nextLng, nextLat]);
  }

  return {
    type: 'Polygon' as const,
    coordinates: [coordinates],
  };
};

export const MapEngine: React.FC<MapEngineProps> = ({
  onMapReady,
  height = 'h-80 lg:h-96',
  viewMode = clientConfig.map.viewModeDefault,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const adapterRef = useRef<MapEngineAdapter | null>(null);
  const viewModeRef = useRef<MapViewMode>(viewMode);
  const userLocationPopupRef = useRef<Popup | null>(null);
  const currentUserLocationRef = useRef<[number, number] | null>(null);
  const geolocationWatchIdRef = useRef<number | null>(null);
  const permissionStatusRef = useRef<PermissionStatus | null>(null);
  const previousLocationRef = useRef<[number, number] | null>(null);
  const userHeadingRef = useRef<number>(0);
  const movingUntilRef = useRef<number>(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const navigationRuntimeRef = useRef(new NavigationSensorRuntime('walking', clientConfig.map.center));

  const scaleControlRef = useRef<ScaleControl | null>(null);
  const attributionControlRef = useRef<AttributionControl | null>(null);
  const resizeAnimationFrameRef = useRef<number | null>(null);
  const userLocationInteractionsBoundRef = useRef(false);
  const sessionHandlersRef = useRef<Record<string, unknown> | null>(null);
  const viewModeSettleTimeoutRef = useRef<number | null>(null);
  const viewModeTransitionTokenRef = useRef(0);
  const {
    setUserLocation,
    setNavigationPose,
    setUserMotion,
    gpsTrackingRequested,
    gpsRequestToken,
    setGpsDiagnostics,
    routePreviewActive,
    followUserLocation,
    activeLiveSessionId,
  } = useAppStore();
  const routePreviewActiveRef = useRef(routePreviewActive);
  const followUserLocationRef = useRef(followUserLocation);

  useEffect(() => {
    routePreviewActiveRef.current = routePreviewActive;
  }, [routePreviewActive]);

  useEffect(() => {
    followUserLocationRef.current = followUserLocation;
  }, [followUserLocation]);

  const applyViewMode = useCallback((mode: MapViewMode): void => {
    viewModeRef.current = mode;
    const map = mapRef.current;
    if (!map) {
      return;
    }

    syncUserLocationLayerAlignment(map, mode);
    syncUserLocationLayerPlacement(map);

    const reducedMode = resolveReducedViewMode(mode);
    const suppressViewModeCamera = routePreviewActiveRef.current && !followUserLocationRef.current;

    const targetPitch = suppressViewModeCamera
      ? map.getPitch()
      : reducedMode === '2_5d'
        ? Math.min(Math.max(clientConfig.map.pitch, 0), 60)
        : clientConfig.map.minPitch;
    const targetBearing = suppressViewModeCamera
      ? map.getBearing()
      : reducedMode === '2_5d'
        ? (clientConfig.map.bearing % 360)
        : 0;
    const targetZoom = suppressViewModeCamera
      ? map.getZoom()
      : reducedMode === '2_5d'
        ? Math.max(map.getZoom(), clientConfig.map.realismZoomThreshold ?? 16.4)
        : map.getZoom();

    const transitionToken = ++viewModeTransitionTokenRef.current;
    if (viewModeSettleTimeoutRef.current !== null) {
      window.clearTimeout(viewModeSettleTimeoutRef.current);
      viewModeSettleTimeoutRef.current = null;
    }

    const enforceViewMode = (): void => {
      if (mapRef.current !== map || viewModeTransitionTokenRef.current !== transitionToken || !map.isStyleLoaded()) {
        return;
      }

      syncUserLocationLayerAlignment(map, mode);
      syncUserLocationLayerPlacement(map);

      if (
        Math.abs(map.getPitch() - targetPitch) > 0.5 ||
        Math.abs(map.getBearing() - targetBearing) > 0.5 ||
        Math.abs(map.getZoom() - targetZoom) > 0.05
      ) {
        map.jumpTo({
          center: map.getCenter(),
          pitch: targetPitch,
          bearing: targetBearing,
          zoom: targetZoom,
        });
      }
    };

    map.easeTo({
      pitch: targetPitch,
      bearing: targetBearing,
      zoom: targetZoom,
      duration: 550, // Increased from 420 for smoother transition
      essential: true,
    });

    map.once('moveend', () => {
      enforceViewMode();
      requestAnimationFrame(() => {
        enforceViewMode();
      });
    });

    map.once('idle', () => {
      enforceViewMode();
    });

    viewModeSettleTimeoutRef.current = window.setTimeout(() => {
      enforceViewMode();
      if (viewModeSettleTimeoutRef.current !== null) {
        window.clearTimeout(viewModeSettleTimeoutRef.current);
        viewModeSettleTimeoutRef.current = null;
      }
    }, 900);
  }, []);

  const clearUserLocationVisuals = useCallback((): void => {
    if (userLocationPopupRef.current) {
      userLocationPopupRef.current.remove();
    }

    const map = mapRef.current;
    if (map?.isStyleLoaded()) {
      setGeoJsonSourceData(map, USER_LOCATION_SOURCE_ID, emptyUserLocationCollection());
    }
    clearAccuracyCircle(mapRef.current);

    currentUserLocationRef.current = null;
    previousLocationRef.current = null;
    userHeadingRef.current = 0;
    movingUntilRef.current = 0;
    navigationRuntimeRef.current.clear();
  }, []);

  const ensureUserLocationPopup = useCallback((location: [number, number] | null): Popup | null => {
    const map = mapRef.current;
    if (!map || !location) {
      return null;
    }

    if (!userLocationPopupRef.current) {
      userLocationPopupRef.current = new Popup({
        closeButton: false,
        closeOnClick: true,
        offset: [0, -18],
        className: 'me-popup',
      }).setText('Your Location');
    }

    userLocationPopupRef.current.setLngLat([location[1], location[0]]);
    return userLocationPopupRef.current;
  }, []);

  const applyNavigationPoseToMap = useCallback((pose: NavigationPose): void => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const location = pose.snappedPosition ?? pose.position;
    const isMoving = pose.state === 'walking' || pose.state === 'driving' || pose.state === 'turning';
    currentUserLocationRef.current = location;
    userHeadingRef.current = pose.headingDeg;

    if (map.isStyleLoaded()) {
      ensureUserLocationSource(map);
      setGeoJsonSourceData(
        map,
        USER_LOCATION_SOURCE_ID,
        buildUserLocationCollection(location, isMoving)
      );

      const shouldUpdateAccuracy =
        !previousLocationRef.current ||
        haversineDistanceMeters(previousLocationRef.current, location) >= 1.2 ||
        Math.abs((pose.accuracyM || 0) - (useAppStore.getState().userMotion.accuracyM ?? 0)) >= 3;

      if (shouldUpdateAccuracy) {
        updateAccuracyCircle(map, location, Math.min(160, Math.max(8, pose.accuracyM)));
      }
    }

    ensureUserLocationPopup(location);
    previousLocationRef.current = location;
  }, [ensureUserLocationPopup]);

  useEffect(() => {
    const runtime = navigationRuntimeRef.current;
    const unsubscribeSnapshot = runtime.subscribe((snapshot) => {
      const pose = snapshot.pose.confidence > 0 ? snapshot.pose : null;
      setNavigationPose(pose);
      if (!pose) {
        return;
      }

      setUserMotion({
        speedMpsRaw: pose.speedMps,
        speedMpsInferred: pose.speedMps,
        speedMpsEffective: pose.speedMps,
        accuracyM: pose.accuracyM,
        headingDeg: pose.headingDeg,
        timestampMs: pose.timestampMs,
        state:
          pose.state === 'stationary'
            ? 'idle'
            : pose.state === 'signal_lost'
              ? 'paused'
              : 'moving',
      });
    });
    const unsubscribeVisualPose = runtime.subscribeVisualPose((pose) => {
      if (useAppStore.getState().isBroadcastingLive) {
        return;
      }
      applyNavigationPoseToMap(pose);
    });

    return () => {
      unsubscribeSnapshot();
      unsubscribeVisualPose();
    };
  }, [applyNavigationPoseToMap, setNavigationPose, setUserMotion]);

  useEffect(() => {
    if (typeof window === 'undefined' || !gpsTrackingRequested) {
      return;
    }

    const runtime = navigationRuntimeRef.current;
    const handleOrientation = (event: DeviceOrientationEvent): void => {
      const compassEvent = event as DeviceOrientationEvent & {
        webkitCompassHeading?: number;
        webkitCompassAccuracy?: number;
      };
      const heading =
        typeof compassEvent.webkitCompassHeading === 'number' && Number.isFinite(compassEvent.webkitCompassHeading)
          ? compassEvent.webkitCompassHeading
          : typeof event.alpha === 'number' && Number.isFinite(event.alpha)
            ? 360 - event.alpha
            : null;

      runtime.updateOrientation({
        headingDeg: heading,
        accuracyDeg:
          typeof compassEvent.webkitCompassAccuracy === 'number'
            ? compassEvent.webkitCompassAccuracy ?? null
            : null,
        timestampMs: Date.now(),
      });
    };
    const handleMotion = (event: DeviceMotionEvent): void => {
      const rotationAlpha = event.rotationRate?.alpha;
      const acceleration = event.acceleration;
      const accelerationMps2 =
        acceleration &&
        typeof acceleration.x === 'number' &&
        typeof acceleration.y === 'number' &&
        typeof acceleration.z === 'number'
          ? Math.hypot(acceleration.x ?? 0, acceleration.y ?? 0, acceleration.z ?? 0)
          : null;

      runtime.updateMotion({
        rotationRateAlphaDegS:
          typeof rotationAlpha === 'number' && Number.isFinite(rotationAlpha) ? rotationAlpha : null,
        accelerationMps2,
        timestampMs: Date.now(),
      });
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('devicemotion', handleMotion, true);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
      window.removeEventListener('devicemotion', handleMotion, true);
    };
  }, [gpsTrackingRequested]);

  const requestScreenWakeLock = useCallback(async (): Promise<void> => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      return;
    }

    if (wakeLockRef.current) {
      return;
    }

    const wakeLockNavigator = navigator as Navigator & {
      wakeLock?: {
        request: (type: 'screen') => Promise<WakeLockSentinel>;
      };
    };

    if (!wakeLockNavigator.wakeLock?.request) {
      return;
    }

    try {
      const wakeLock = await wakeLockNavigator.wakeLock.request('screen');
      wakeLockRef.current = wakeLock;

      wakeLock.addEventListener('release', () => {
        if (wakeLockRef.current === wakeLock) {
          wakeLockRef.current = null;
        }
      });
    } catch (error) {
      console.warn('Screen wake lock request failed:', error);
    }
  }, []);

  const releaseScreenWakeLock = useCallback(async (): Promise<void> => {
    if (!wakeLockRef.current) {
      return;
    }

    try {
      await wakeLockRef.current.release();
    } catch {
      // Ignore wake lock release failures.
    } finally {
      wakeLockRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildMapStyle(),
      center: [clientConfig.map.center[1], clientConfig.map.center[0]],
      zoom: clientConfig.map.zoom,
      minZoom: clientConfig.map.minZoom,
      maxZoom: clientConfig.map.maxZoom,
      pitch: 0,
      bearing: 0,
      maxPitch: clientConfig.map.maxPitch,
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      doubleClickZoom: false, // Disable to prevent interference with rapid building selection
    });


    scaleControlRef.current = new ScaleControl({
      maxWidth: 110,
      unit: 'metric',
    });
    attributionControlRef.current = new AttributionControl({
      compact: true,
    });

    const syncMapViewport = (): void => {
      if (resizeAnimationFrameRef.current !== null) {
        cancelAnimationFrame(resizeAnimationFrameRef.current);
      }

      resizeAnimationFrameRef.current = requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = null;
        map.resize();
        syncScaleControlPosition();
      });
    };

    const syncScaleControlPosition = (): void => {
      if (!scaleControlRef.current) {
        return;
      }

      try {
        map.removeControl(scaleControlRef.current);
      } catch {
        // Ignore the initial reposition before the control is mounted.
      }
      map.addControl(
        scaleControlRef.current,
        typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches
          ? 'top-right'
          : 'bottom-right'
      );
    };


    syncScaleControlPosition();
    map.addControl(attributionControlRef.current, 'bottom-right');

    const handleUserLocationLayerClick = (): void => {
      const popup = ensureUserLocationPopup(currentUserLocationRef.current);
      popup?.addTo(map);
    };

    const handleUserLocationLayerEnter = (): void => {
      map.getCanvas().style.cursor = 'pointer';
    };

    const handleUserLocationLayerLeave = (): void => {
      map.getCanvas().style.cursor = '';
    };

    const handleStyleData = (): void => {
      if (!map.isStyleLoaded()) {
        return;
      }

      hideDefaultVectorLayers(map);
      ensureAccuracySource(map);
      ensureUserLocationSource(map);
      syncUserLocationLayerAlignment(map, viewModeRef.current);
      bindUserLocationInteractions();
      if (currentUserLocationRef.current) {
        setGeoJsonSourceData(
          map,
          USER_LOCATION_SOURCE_ID,
          buildUserLocationCollection(
            currentUserLocationRef.current,
            Date.now() < movingUntilRef.current
          )
        );
      }
      syncUserLocationLayerPlacement(map);

    };

    const handleMapIdle = (): void => {
      if (!map.isStyleLoaded()) {
        return;
      }

      syncUserLocationLayerPlacement(map);
    };

    const bindUserLocationInteractions = (): void => {
      if (userLocationInteractionsBoundRef.current) {
        return;
      }

      USER_LOCATION_LAYER_IDS.forEach((layerId) => {
        if (!map.getLayer(layerId)) {
          return;
        }

        map.on('click', layerId, handleUserLocationLayerClick);
        map.on('mouseenter', layerId, handleUserLocationLayerEnter);
        map.on('mouseleave', layerId, handleUserLocationLayerLeave);
      });
      userLocationInteractionsBoundRef.current = true;
    };

    // Hint handlers (show once per user via ToastContext `once` flag)
    const handleFirstZoomStart = (): void => {
      try {
        publishToast({
          type: 'info',
          title: 'Tip',
          message: 'You can zoom the map with scroll or the controls.',
          dedupeKey: 'hint-zoom',
          once: true,
        });
      } catch {}
      map.off('zoomstart', handleFirstZoomStart);
    };

    const handleFirstPitchChange = (): void => {
      try {
        if (map.getPitch() > 4) {
          publishToast({
            type: 'info',
            title: 'Tip',
            message: 'Tilt the map to view buildings in 2.5D.',
            dedupeKey: 'hint-tilt',
            once: true,
          });
          map.off('move', handleFirstPitchChange);
        }
      } catch {}
    };

    const unbindUserLocationInteractions = (): void => {
      if (!userLocationInteractionsBoundRef.current) {
        return;
      }

      USER_LOCATION_LAYER_IDS.forEach((layerId) => {
        if (!map.getLayer(layerId)) {
          return;
        }

        map.off('click', layerId, handleUserLocationLayerClick);
        map.off('mouseenter', layerId, handleUserLocationLayerEnter);
        map.off('mouseleave', layerId, handleUserLocationLayerLeave);
      });
      userLocationInteractionsBoundRef.current = false;
    };

    // Store session-scoped handler refs so they can be used for registration/teardown.
    sessionHandlersRef.current = {
      handleUserLocationLayerClick,
      handleUserLocationLayerEnter,
      handleUserLocationLayerLeave,
      handleStyleData,
      handleMapIdle,
      bindUserLocationInteractions,
      unbindUserLocationInteractions,
      syncMapViewport,
      syncScaleControlPosition,
      handleFirstZoomStart,
      handleFirstPitchChange,
    };

    const containerElement = containerRef.current;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && containerElement
        ? new ResizeObserver(() => {
            syncMapViewport();
          })
        : null;
    resizeObserver?.observe(containerElement);

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', syncMapViewport);
      window.addEventListener('orientationchange', syncMapViewport);
    }

    const adapter: MapEngineAdapter = {
      nativeMap: map,
      flyTo: (center, zoom, options) => {
        // Clamp zoom to valid range
        const clampedZoom = Math.max(
          clientConfig.map.minZoom,
          Math.min(clientConfig.map.maxZoom, zoom ?? map.getZoom())
        );

        // Limit pitch during zoom to prevent distortion
        const currentPitch = map.getPitch();
        const targetPitch = clampedZoom >= 18.5 ? Math.min(currentPitch, 45) : currentPitch;

        map.flyTo({
          center: [center[1], center[0]],
          zoom: clampedZoom,
          pitch: targetPitch,
          bearing: map.getBearing(),
          duration: typeof options?.duration === 'number' ? options.duration * 1000 : 800,
          essential: true,
        });
      },
      panTo: (center, options) => {
        map.easeTo({
          center: [center[1], center[0]],
          duration: typeof options?.duration === 'number' ? options.duration * 1000 : 600,
          essential: true,
        });
      },
      fitBounds: (bounds, options) => {
        map.fitBounds(
          new LngLatBounds(
            [bounds[0][1], bounds[0][0]],
            [bounds[1][1], bounds[1][0]]
          ),
          {
            padding:
              typeof options?.padding === 'number'
                ? options.padding
                : {
                    top: options?.padding?.top ?? 24,
                    right: options?.padding?.right ?? 24,
                    bottom: options?.padding?.bottom ?? 24,
                    left: options?.padding?.left ?? 24,
                  },
            duration: typeof options?.duration === 'number' ? options.duration * 1000 : 700,
          }
        );
      },
      getCenter: () => {
        const center = map.getCenter();
        return [center.lat, center.lng];
      },
      getZoom: () => map.getZoom(),
      distance: (from, to) => haversineDistanceMeters(from, to),
      project: (location) => {
        const point = map.project([location[1], location[0]]);
        return { x: point.x, y: point.y };
      },
      unproject: (point) => {
        const location = map.unproject([point.x, point.y]);
        return [location.lat, location.lng];
      },
      setViewMode: applyViewMode,
      getViewMode: () => viewModeRef.current,
      openUserLocationPopup: () => {
        ensureUserLocationPopup(currentUserLocationRef.current)?.addTo(map);
      },
      flyToUserLocationWithPopup: (location, zoom = 17, duration = 0.6) => {
        map.once('moveend', () => {
          ensureUserLocationPopup(location)?.addTo(map);
        });
        map.flyTo({
          center: [location[1], location[0]],
          zoom,
          duration: duration * 1000,
          essential: true,
        });
      },
      once: (event, handler) => {
        map.once(event, handler);
      },
      on: (event, handler) => {
        map.on(event, handler);
        return () => {
          map.off(event, handler);
        };
      },
      isStyleLoaded: () => Boolean(map.isStyleLoaded()),
    };

    mapRef.current = map;
    adapterRef.current = adapter;
    onMapReady?.(adapter);

    map.once('load', () => {
      applyViewMode(viewModeRef.current);
      hideDefaultVectorLayers(map);
      ensureAccuracySource(map);
      ensureUserLocationSource(map);
      syncUserLocationLayerAlignment(map, viewModeRef.current);
      syncUserLocationLayerPlacement(map);
      bindUserLocationInteractions();
      syncMapViewport();
    });
    map.on('styledata', (sessionHandlersRef.current as any)?.handleStyleData);
    map.on('idle', (sessionHandlersRef.current as any)?.handleMapIdle);
    // Register first-use hints
    map.on('zoomstart', (sessionHandlersRef.current as any)?.handleFirstZoomStart);
    map.on('move', (sessionHandlersRef.current as any)?.handleFirstPitchChange);

    return (): void => {
      onMapReady?.(null);

      if (geolocationWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(geolocationWatchIdRef.current);
        geolocationWatchIdRef.current = null;
      }

      if (permissionStatusRef.current) {
        permissionStatusRef.current.onchange = null;
        permissionStatusRef.current = null;
      }

      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', syncMapViewport);
        window.removeEventListener('orientationchange', syncMapViewport);
      }
      resizeObserver?.disconnect();
      if (resizeAnimationFrameRef.current !== null) {
        cancelAnimationFrame(resizeAnimationFrameRef.current);
        resizeAnimationFrameRef.current = null;
      }
      if (viewModeSettleTimeoutRef.current !== null) {
        window.clearTimeout(viewModeSettleTimeoutRef.current);
        viewModeSettleTimeoutRef.current = null;
      }

      void endRouteTelemetrySession();
      void releaseScreenWakeLock();
      clearUserLocationVisuals();
      const sessionHandlers = sessionHandlersRef.current as any;
      if (sessionHandlers) {
        sessionHandlers.unbindUserLocationInteractions?.();
        map.off('styledata', sessionHandlers.handleStyleData);
        map.off('idle', sessionHandlers.handleMapIdle);
        sessionHandlersRef.current = null;
      } else {
        unbindUserLocationInteractions();
        map.off('styledata', handleStyleData);
        map.off('idle', handleMapIdle);
      }
      setUserLocation(null);
      setNavigationPose(null);
      map.remove();

      adapterRef.current = null;
      mapRef.current = null;
    };
  }, [
    applyViewMode,
    clearUserLocationVisuals,
    endRouteTelemetrySession,
    onMapReady,
    releaseScreenWakeLock,
    setUserLocation,
    setNavigationPose,
  ]);

  useEffect(() => {
    applyViewMode(viewMode);
  }, [applyViewMode, viewMode]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    if (!gpsTrackingRequested) {
      void releaseScreenWakeLock();
      return;
    }

    void requestScreenWakeLock();

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void requestScreenWakeLock();
        return;
      }

      void releaseScreenWakeLock();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void releaseScreenWakeLock();
    };
  }, [gpsTrackingRequested, releaseScreenWakeLock, requestScreenWakeLock]);

  useEffect(() => {
    const isBroadcasting = useAppStore.getState().isBroadcastingLive;
    if (isBroadcasting) {
      clearUserLocationVisuals();
      
      const map = mapRef.current;
      if (map && map.isStyleLoaded()) {
        setGeoJsonSourceData(map, USER_LOCATION_SOURCE_ID, {
          type: 'FeatureCollection',
          features: [],
        });
        updateAccuracyCircle(map, [0, 0], 0);
      }
    }
  }, [activeLiveSessionId, clearUserLocationVisuals]);

  useEffect(() => {
    const detachPermissionListener = (): void => {
      if (permissionStatusRef.current) {
        permissionStatusRef.current.onchange = null;
        permissionStatusRef.current = null;
      }
    };

    const clearGeolocationWatch = (): void => {
      if (geolocationWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(geolocationWatchIdRef.current);
        geolocationWatchIdRef.current = null;
      }
    };

    installRouteTelemetryOnlineHandler();

    const permissionState = useAppStore.getState().gpsDiagnostics.permission;
    if (!gpsTrackingRequested && permissionState !== 'granted') {
      clearUserLocationVisuals();
      setUserLocation(null);
      setGpsDiagnostics({
        status: 'idle',
        errorMessage: null,
      });
      return;
    }

    if (typeof navigator === 'undefined') {
      return;
    }

    if (!('geolocation' in navigator)) {
      clearUserLocationVisuals();
      setUserLocation(null);
      setGpsDiagnostics({
        status: 'unsupported',
        permission: 'denied',
        errorMessage: 'Geolocation is not supported by this browser.',
      });
      return;
    }

    let cancelled = false;

    const startWatch = (): void => {
      if (cancelled || geolocationWatchIdRef.current !== null) {
        return;
      }

      ensureRouteTelemetrySession(clientConfig.campus_id);

      if (gpsTrackingRequested) {
        setGpsDiagnostics({
          status: 'checking',
          errorMessage: null,
        });
      }

      geolocationWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          if (cancelled) {
            return;
          }

          const location: [number, number] = [
            position.coords.latitude,
            position.coords.longitude,
          ];
          const accuracyM =
            typeof position.coords.accuracy === 'number' && Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : 80;
          const permission = permissionStatusRef.current
            ? toGpsPermissionState(permissionStatusRef.current.state)
            : 'granted';

          setUserLocation(location);
          setGpsDiagnostics({
            status: 'ready',
            permission,
            errorMessage: null,
          });

          void recordRouteTelemetryPoint(clientConfig.campus_id, {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM,
            headingDeg:
              typeof position.coords.heading === 'number' && Number.isFinite(position.coords.heading)
                ? position.coords.heading
                : null,
            speedMps:
              typeof position.coords.speed === 'number' && Number.isFinite(position.coords.speed)
                ? position.coords.speed
                : null,
            timestampMs: position.timestamp,
          });

          const pose = navigationRuntimeRef.current.ingestFix({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM,
            headingDeg:
              typeof position.coords.heading === 'number' && Number.isFinite(position.coords.heading)
                ? position.coords.heading
                : null,
            speedMps:
              typeof position.coords.speed === 'number' && Number.isFinite(position.coords.speed)
                ? position.coords.speed
                : null,
            timestampMs: position.timestamp,
            source: 'gps',
          });

          const map = mapRef.current;
          if (!map) {
            return;
          }

          currentUserLocationRef.current = location;

          const isBroadcasting = useAppStore.getState().isBroadcastingLive;

          if (isBroadcasting) {
            if (map.isStyleLoaded()) {
              setGeoJsonSourceData(map, USER_LOCATION_SOURCE_ID, {
                type: 'FeatureCollection',
                features: [],
              });
              updateAccuracyCircle(map, location, 0);
            }
            return;
          }

          if (!pose) {
            if (map.isStyleLoaded()) {
              ensureUserLocationSource(map);
              setGeoJsonSourceData(map, USER_LOCATION_SOURCE_ID, buildUserLocationCollection(location, false));
              updateAccuracyCircle(map, location, Math.min(160, Math.max(8, accuracyM)));
              syncUserLocationLayerPlacement(map);
            }
            ensureUserLocationPopup(location);
            return;
          }

          const visualLocation = pose.snappedPosition ?? pose.position;
          const movementDetected = detectMovement(previousLocationRef.current, visualLocation, pose.speedMps);

          if (movementDetected) {
            movingUntilRef.current = Date.now() + MOVING_GLOW_HOLD_MS;
          }
          applyNavigationPoseToMap(pose);

        },
        (error) => {
          if (cancelled) {
            return;
          }

          const nextStatus = gpsStatusFromErrorCode(error.code);
          const permission =
            nextStatus === 'permission-denied'
              ? 'denied'
              : permissionStatusRef.current
                ? toGpsPermissionState(permissionStatusRef.current.state)
                : 'unknown';

          if (gpsTrackingRequested) {
            clearUserLocationVisuals();
            setUserLocation(null);
            setGpsDiagnostics({
              status: nextStatus,
              permission,
              errorMessage: error.message || 'Unable to read your location.',
            });

            console.warn('Location error:', error.message);
            publishToast({
              type: 'warning',
              title: 'Location access',
              message: error.message || 'Unable to read your location right now.',
              dedupeKey: `map-location-error-${nextStatus}`,
            });
          }

          if (nextStatus === 'permission-denied') {
            clearGeolocationWatch();
            void endRouteTelemetrySession();
          }
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000,
        }
      );
    };

    const handlePermissionState = (state: PermissionState): void => {
      const permission = toGpsPermissionState(state);

      if (permission === 'denied') {
        clearGeolocationWatch();
        void endRouteTelemetrySession();
        clearUserLocationVisuals();
        setUserLocation(null);
        setGpsDiagnostics({
          status: 'permission-denied',
          permission: 'denied',
          errorMessage: 'Location access is blocked for this site.',
        });
        return;
      }

      setGpsDiagnostics({ permission });

      if (permission === 'granted' || gpsTrackingRequested) {
        startWatch();
      }
    };

    if ('permissions' in navigator && typeof navigator.permissions?.query === 'function') {
      void navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((permissionStatus) => {
          if (cancelled) {
            return;
          }

          permissionStatusRef.current = permissionStatus;
          handlePermissionState(permissionStatus.state);

          permissionStatus.onchange = () => {
            if (!cancelled && permissionStatusRef.current) {
              handlePermissionState(permissionStatusRef.current.state);
            }
          };
        })
        .catch(() => {
          if (!cancelled && gpsTrackingRequested) {
            startWatch();
          }
        });
    } else if (gpsTrackingRequested) {
      startWatch();
    }

    return (): void => {
      cancelled = true;
      detachPermissionListener();
      clearGeolocationWatch();
      void endRouteTelemetrySession();
    };
  }, [
    clearUserLocationVisuals,
    endRouteTelemetrySession,
    ensureRouteTelemetrySession,
    gpsRequestToken,
    gpsTrackingRequested,
    installRouteTelemetryOnlineHandler,
    recordRouteTelemetryPoint,
    setGpsDiagnostics,
    setUserLocation,
    setUserMotion,
  ]);

  return <div ref={containerRef} className={'w-full ' + height} />;
};

export default MapEngine;
