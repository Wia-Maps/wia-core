import {
  lazy,
  startTransition,
  Suspense,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { MapEngine } from '../core/MapEngine';
import { resolveFeatureAnchorCoordinates, resolveFeatureId, resolveFeatureVisualClass } from '../core/geoGeometry';
import { GateLayer } from '../core/GateLayer';
import { LocationOutlineLayer } from '../core/LocationOutlineLayer';
import { MarkerLayer } from '../core/MarkerLayer';
import { NavigationFeedbackLayer } from '../core/NavigationFeedbackLayer';
import { RoutePreviewLayer } from '../core/RoutePreviewLayer';
import { FellowshipLayer } from '../core/FellowshipLayer';
import { PowerSupplyOverlayLayer } from '../core/PowerSupplyOverlayLayer';
import type { MapEngineAdapter, MapViewMode } from '../core/mapEngineTypes';
import {
  buildCampusRoutePreview,
  createMotionEtaRuntimeState,
  enrichRoutePreviewWithTracking,
  trackLocationOnRoute,
} from '../core/navigation';
import { runtimeRoutingClient } from '../core/runtimeRoutingClient';
import { getGpsGuidance } from '../core/gpsStatus';
import type { LoadState } from '../core/loadState';
import { flyToUserLocationWithPopup } from '../core/mapLocation';
import { haversineDistanceMeters } from '../core/mapMetrics';
import {
  POWER_SUPPLY_FILTER,
  isPowerSupplyFilter,
    matchesLocationFilters,
} from '../core/locationFilters';
import {
  buildNavigationCameraTarget,
  getBearing,
  normalizeBearing,
  shortestAngleDelta,
  type NavigationCameraState,
} from '../core/navigationCamera';
import { matchPoseToRoute } from '../core/navigation/routeMatcher';
import { createRerouteState, updateRerouteState } from '../core/navigation/reroute';
import type { RouteMatch } from '../core/navigation/types';
import { SearchBar } from './SearchBar';
import WeatherLayerCard from './WeatherLayerCard';
import { useAppStore } from '../store/useAppStore';
import {
  startBroadcasting,
  stopBroadcasting,
  joinAsViewer,
  leaveSession,
  getStoredSOSSession,
  getStoredViewerLiveToken,
} from '../services/liveLocation';
import type {
  NotificationFeedEvent,
  RouteFocusHighlight,
  RoutePreview,
  RouteStep,
  StoredLocation,
} from '../store/useAppStore';
import { clientConfig } from '../config/client';
import { useToast } from '../context/ToastContext';
import { formatRelativeTime } from '../utils/dateTime';
import { createLiveShareSession, resolveLiveShareSession } from '../services/liveShare';

const PowerStatusLayer = lazy(() => import('../core/PowerStatusLayer'));

interface BuildingProperties {
  id?: string;
  name?: string;
  type?: string;
  features?: string[];
  fellowships?: unknown;
  [key: string]: unknown;
}

type CampusFeature = Feature<Geometry, BuildingProperties>;
type CampusCollection = FeatureCollection<Geometry, BuildingProperties>;

type RailView = 'favourite' | 'recent' | 'alerts' | 'live' | null;
type CampusPanel = 'directory' | 'layers' | null;
type FixedRouteTrackingStatus = 'on_route' | 'off_route';

const OFF_ROUTE_ENTER_THRESHOLD_M = 18;
const OFF_ROUTE_EXIT_THRESHOLD_M = 10;
const OFF_ROUTE_ENTRY_SAMPLE_COUNT = 2;
const OFF_ROUTE_MESSAGE = "Checking your position against the route. Keep moving and WIA will adjust if you're really off path.";
const AUTO_REROUTE_COOLDOWN_MS = 8000;
const AUTO_REROUTE_MIN_MOVEMENT_M = 8;
const MOBILE_MENU_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const DESKTOP_ZOOM_BOTTOM_PX = 170;
const MOBILE_ZOOM_BOTTOM_PX = 130;
const MOBILE_ZOOM_BOTTOM_WITH_LIVE_PX = 192;
const MOBILE_LOCATE_BOTTOM_PX = 82;
const MOBILE_LOCATE_BOTTOM_WITH_LIVE_PX = 144;
const MOBILE_OPEN_LAYERS_BOTTOM_PX = 14;
const MOBILE_OPEN_LAYERS_BOTTOM_WITH_LIVE_PX = 124;
const MOBILE_OPEN_LAYERS_RIGHT_PX = 12;
const MOBILE_OPEN_LAYERS_RIGHT_WITH_LIVE_PX = 56;

const formatNavigationDistance = (distanceM: number | null | undefined): string => {
  if (typeof distanceM !== 'number' || !Number.isFinite(distanceM) || distanceM <= 0) {
    return '0 m';
  }

  if (distanceM >= 1000) {
    return `${(distanceM / 1000).toFixed(distanceM >= 10000 ? 0 : 1)} km`;
  }

  return `${Math.max(1, Math.round(distanceM))} m`;
};

const cleanRoutePreviewInstruction = (instruction: string, distanceM: number): string => {
  const distanceLabel = formatNavigationDistance(distanceM);
  return instruction
    .replace(new RegExp(`\\s+for\\s+${distanceLabel.replace('.', '\\.').replace(' ', '\\s*')}$`, 'i'), '')
    .replace(/\s+for\s+\d+(?:\.\d+)?\s*(?:m|km|meters?|kilometers?)$/i, '')
    .trim();
};

const routeManeuverIcon = (step: RouteStep | null | undefined): 'straight' | 'left' | 'right' | 'uturn' => {
  const instruction = step?.instruction.toLowerCase() ?? '';
  if (instruction.includes('u-turn')) {
    return 'uturn';
  }

  if (instruction.includes('left')) {
    return 'left';
  }

  if (instruction.includes('right')) {
    return 'right';
  }

  return 'straight';
};

const routeFocusManeuver = (
  step: RouteStep | null | undefined
): RouteFocusHighlight['maneuver'] => {
  const instruction = step?.instruction.toLowerCase() ?? '';
  if (instruction.includes('u-turn')) {
    return 'uturn';
  }

  if (instruction.includes('sharp') && instruction.includes('right')) {
    return 'sharp-right';
  }

  if (instruction.includes('sharp') && instruction.includes('left')) {
    return 'sharp-left';
  }

  if (instruction.includes('right')) {
    return 'right';
  }

  if (instruction.includes('left')) {
    return 'left';
  }

  if (instruction.includes('continue')) {
    return 'continue';
  }

  return 'straight';
};

const lerp = (from: number, to: number, factor: number): number => from + (to - from) * factor;

const lerpLocation = (
  from: [number, number],
  to: [number, number],
  factor: number
): [number, number] => [
  lerp(from[0], to[0], factor),
  lerp(from[1], to[1], factor),
];

const routePointAtDistance = (
  path: [number, number][],
  targetDistanceM: number
): [number, number] => {
  if (path.length === 0) {
    return [0, 0];
  }

  if (path.length === 1 || targetDistanceM <= 0) {
    return path[0];
  }

  let travelledM = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const next = path[index];
    const segmentM = haversineDistanceMeters(previous, next);
    if (travelledM + segmentM >= targetDistanceM) {
      const ratio = segmentM <= 0 ? 0 : (targetDistanceM - travelledM) / segmentM;
      return lerpLocation(previous, next, Math.max(0, Math.min(1, ratio)));
    }

    travelledM += segmentM;
  }

  return path[path.length - 1];
};

const routePathBetweenDistances = (
  path: [number, number][],
  startDistanceM: number,
  endDistanceM: number
): [number, number][] => {
  if (path.length < 2) {
    return path;
  }

  const start = Math.max(0, startDistanceM);
  const end = Math.max(start, endDistanceM);
  const points: [number, number][] = [routePointAtDistance(path, start)];
  let travelledM = 0;

  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const next = path[index];
    const segmentM = haversineDistanceMeters(previous, next);
    const segmentStartM = travelledM;
    const segmentEndM = travelledM + segmentM;

    if (segmentEndM > start && segmentStartM < end) {
      if (segmentEndM >= end) {
        const endPoint = routePointAtDistance(path, end);
        const lastPoint = points[points.length - 1];
        if (!lastPoint || haversineDistanceMeters(lastPoint, endPoint) > 0.2) {
          points.push(endPoint);
        }
        break;
      }

      points.push(next);
    }

    travelledM = segmentEndM;
  }

  const endPoint = routePointAtDistance(path, end);
  const lastPoint = points[points.length - 1];
  if (!lastPoint || haversineDistanceMeters(lastPoint, endPoint) > 0.2) {
    points.push(endPoint);
  }

  return points.length >= 2 ? points : [points[0], points[0]];
};

interface BuildingInfo {
  id: string;
  name: string;
  type: string;
  features: string[];
  coordinates: [number, number];
  properties: Record<string, unknown>;
}

interface SearchSelection {
  id: string;
  name: string;
  type: string;
  coordinates: [number, number];
  properties?: Record<string, unknown>;
  fellowshipFocusCode?: string | null;
  fellowshipServiceFocusKey?: string | null;
}

interface HomePageProps {
  geojsonData?: CampusCollection | null;
  routingData?: CampusCollection | null;
  locationsState?: LoadState;
  routingState?: LoadState;
  routingRuntimeAvailable?: boolean;
  mapInstance?: MapEngineAdapter | null;
  onMapReady?: (map: MapEngineAdapter | null) => void;
}

const featureId = (feature: CampusFeature, index: number): string => {
  return resolveFeatureId(feature, index) ?? `feature_${index}`;
};

const displayFilterName = (category: string): string => (
  isPowerSupplyFilter(category) ? 'Power available' : category
);

/**
 * Home screen with full background map and floating UI panels.
 */
export const HomePage: React.FC<HomePageProps> = ({
  geojsonData,
  routingData,
  locationsState = 'idle',
  routingState = 'idle',
  routingRuntimeAvailable = false,
  mapInstance,
  onMapReady,
}) => {
  const {
    selectLocation,
    deselectLocation,
    closeBottomSheet,
    bottomSheetOpen,
    activeFilters,
    toggleFilter,
    allCategories,
    setActiveFilters,
    selectedLocation,
    openBottomSheet,
    favouriteLocations,
    recentLocations,
    notificationEvents,
    notificationFeedSeenAt,
    markNotificationFeedSeen,
    removeFavouriteLocation,
    clearRecentLocations,
    userLocation,
    navigationPose,
    gpsDiagnostics,
    gpsTrackingRequested,
    requestGpsAccess,
    setUserLocation,
    userMotion,
    routePreviewActive,
    routePreview,
    routePreviewStatus,
    setRoutePreview,
    setRoutePreviewStatus,
    setUserMotion,
    setFollowUserLocation,
    clearRoutePreview,
    followUserLocation,
    routeAccessibilityMode,
    sharedIntent,
    setSharedIntent,
    routeFocusHighlight,
    setRouteFocusHighlight,
    setRouteStepPreviewOpen,
    activeLiveSessionId,
    isBroadcastingLive,
    liveConnectionState,
    isSosPreparing,
    setSosPreparing,
    liveViewerCount,
    liveGpsAccuracy,
  } = useAppStore();
  const { showWarning } = useToast();

  const [activeCampusPanel, setActiveCampusPanel] = useState<CampusPanel>(null);
  const [railView, setRailView] = useState<RailView>(null);
  const [railExpanded, setRailExpanded] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [categoryRailExpanded, setCategoryRailExpanded] = useState(false);
  const [showFellowships, setShowFellowships] = useState(false);
  const [showPowerSupplyOverlay, setShowPowerSupplyOverlay] = useState(false);
  const [powerStatusEnabled, setPowerStatusEnabled] = useState(false);
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>(clientConfig.map.viewModeDefault);
  const [gpsHintDismissed, setGpsHintDismissed] = useState(false);
  const [pendingMapViewMode, setPendingMapViewMode] = useState<MapViewMode | null>(null);
  const [routeStepPreviewIndex, setRouteStepPreviewIndex] = useState<number | null>(null);
  const searchActiveRef = useRef(false);
  const lastRouteSignatureRef = useRef('');
  const etaSamplesRef = useRef<number[]>([]);
  const motionEtaStateRef = useRef(createMotionEtaRuntimeState());
  const lastGoodOnRoutePreviewRef = useRef<RoutePreview | null>(null);
  const offRouteSampleStreakRef = useRef(0);
  const trackingStatusRef = useRef<FixedRouteTrackingStatus>('on_route');
  const handledLocationIntentRef = useRef<string | null>(null);
  const handledSharedIntentRef = useRef<string | null>(null);
  const userMotionRef = useRef(userMotion);
  const pendingRouteRequestRef = useRef<{ key: string; requestId: number } | null>(null);
  const lastAutoRerouteAtRef = useRef(0);
  const lastAutoRerouteLocationRef = useRef<[number, number] | null>(null);
  const routeMatchRef = useRef<RouteMatch | null>(null);
  const previousMatchedProgressRef = useRef<number | null>(null);
  const rerouteStateRef = useRef(createRerouteState());
  const navigationBearingRef = useRef<number>(normalizeBearing(clientConfig.map.bearing));
  const navigationCameraRef = useRef<NavigationCameraState | null>(null);
  const navigationCameraTargetRef = useRef<NavigationCameraState | null>(null);
  const navigationCameraFrameRef = useRef<number | null>(null);
  const lastNavigationCameraFrameAtRef = useRef<number>(0);
  const manualCameraOverrideRef = useRef(false);
  const programmaticCameraTokenRef = useRef(0);
  const programmaticCameraReleaseTimeoutRef = useRef<number | null>(null);
  const enhancedViewAvailable = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return true;
    }

    const connection = navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
      deviceMemory?: number;
    };

    if (connection.connection?.saveData) {
      return false;
    }

    if (connection.connection?.effectiveType === '2g' || connection.connection?.effectiveType === 'slow-2g') {
      return false;
    }

    if (typeof connection.deviceMemory === 'number' && connection.deviceMemory <= 2) {
      return false;
    }

    return true;
  }, []);

  const buildings = useMemo<BuildingInfo[]>(() => {
    if (!geojsonData?.features) {
      return [];
    }

    return geojsonData.features
      .filter((feature) => {
        const geometryType = feature.geometry?.type;
        if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
          return false;
        }

        return resolveFeatureVisualClass(feature) === 'structure';
      })
      .map((feature, index) => {
      const rawFeatures = Array.isArray(feature.properties?.features)
        ? feature.properties.features
        : [];

      return {
        id: featureId(feature, index),
        name: feature.properties?.name ?? 'Unknown location',
        type: feature.properties?.type ?? 'Location',
        features: rawFeatures.filter((value): value is string => typeof value === 'string'),
        coordinates: resolveFeatureAnchorCoordinates(feature),
        properties: { ...(feature.properties ?? {}) },
      };
      });
  }, [geojsonData]);

  const categoryCounts = useMemo(() => {
    return buildings.reduce<Record<string, number>>((accumulator, building) => {
      accumulator[building.type] = (accumulator[building.type] ?? 0) + 1;
      return accumulator;
    }, {});
  }, [buildings]);

  const categoryList = useMemo(() => {
    const sourceCategories = allCategories.length > 0
      ? allCategories
      : Object.keys(categoryCounts).sort((left, right) => left.localeCompare(right));

    if (!clientConfig.features.powerStatus) {
      return sourceCategories;
    }

    return [
      POWER_SUPPLY_FILTER,
      ...sourceCategories.filter((category) => !isPowerSupplyFilter(category)),
    ];
  }, [allCategories, categoryCounts]);

  const visibleBuildings = useMemo(() => {
    return buildings.filter((building) => (
      matchesLocationFilters(building.type, activeFilters)
    ));
  }, [activeFilters, buildings]);

  const directoryBuildings = useMemo(() => {
    const source = [...visibleBuildings];

    if (!userLocation) {
      return source.slice(0, 6);
    }

    return source
      .sort((left, right) => (
        haversineDistanceMeters(userLocation, left.coordinates) -
        haversineDistanceMeters(userLocation, right.coordinates)
      ))
      .slice(0, 6);
  }, [userLocation, visibleBuildings]);

  const gpsGuidance = getGpsGuidance(gpsDiagnostics.status, gpsDiagnostics.errorMessage);
  const activeRouteStepIndex = Math.max(0, routePreview?.current_step_index ?? 0);
  const selectedRouteStepIndex = routePreview
    ? Math.min(
      Math.max(routeStepPreviewIndex ?? activeRouteStepIndex, 0),
      Math.max(routePreview.steps.length - 1, 0)
    )
    : 0;
  const selectedRouteStep = routePreview?.steps[selectedRouteStepIndex] ?? null;
  const routeManeuver = routeManeuverIcon(selectedRouteStep);
  const selectedRouteStepInstruction = selectedRouteStep
    ? cleanRoutePreviewInstruction(selectedRouteStep.instruction, selectedRouteStep.distance_m)
    : '';
  const routeStepPreviewOpen = Boolean(
    routePreviewActive &&
    routePreview &&
    selectedLocation &&
    routeStepPreviewIndex !== null
  );

  useEffect(() => {
    setRouteStepPreviewOpen(routeStepPreviewOpen);

    return () => {
      setRouteStepPreviewOpen(false);
    };
  }, [routeStepPreviewOpen, setRouteStepPreviewOpen]);

  useEffect(() => {
    const storedSession = getStoredSOSSession();
    if (storedSession && !activeLiveSessionId) {
      showWarning('You had an active SOS session. It has been resumed.', {
        title: 'SOS Resumed',
        dedupeKey: 'sos-resumed',
      });
      startBroadcasting(storedSession.sessionId, storedSession.broadcasterToken);
      setSharedIntent({
        coordinates: userLocation || [0, 0],
        label: 'My Live SOS',
        isSos: true
      });
    }

    // Auto-request GPS access on app mount to pre-fetch location
    requestGpsAccess();
  }, []);

  useEffect(() => {
    setGpsHintDismissed(false);
  }, [gpsDiagnostics.status, gpsDiagnostics.errorMessage, gpsTrackingRequested]);

  const shouldShowGpsHint =
    !gpsHintDismissed &&
    gpsTrackingRequested &&
    gpsDiagnostics.status !== 'ready' &&
    gpsDiagnostics.status !== 'idle';

  const openLocation = useCallback((
    selection: SearchSelection,
    openDetailsOnLargeScreen = false,
    forceOpenDetails = false
  ): void => {
    selectLocation({
      id: selection.id,
      name: selection.name,
      type: selection.type,
      coordinates: selection.coordinates,
      properties: selection.properties,
      fellowshipFocusCode: selection.fellowshipFocusCode ?? null,
      fellowshipServiceFocusKey: selection.fellowshipServiceFocusKey ?? null,
    });

    if (mapInstance) {
      const center = mapInstance.getCenter();
      const distanceFromCenter = mapInstance.distance(center, selection.coordinates);
      const currentZoom = mapInstance.getZoom();

      if (distanceFromCenter > 140 || currentZoom < 15.6) {
        mapInstance.flyTo(selection.coordinates, Math.min(17, Math.max(currentZoom + 0.7, 16.6)), {
          duration: 0.48,
        });
      } else if (distanceFromCenter > 24) {
        mapInstance.panTo(selection.coordinates, { duration: 0.26 });
      }
    }

    const shouldOpenDetails =
      forceOpenDetails ||
      (openDetailsOnLargeScreen &&
        typeof window !== 'undefined' &&
        window.matchMedia('(min-width: 1024px)').matches);

    if (shouldOpenDetails) {
      openBottomSheet();
    }
  }, [mapInstance, openBottomSheet, selectLocation]);

  const openRailLocation = (location: StoredLocation): void => {
    openLocation(
      {
        id: location.id,
        name: location.name,
        type: location.type,
        coordinates: location.coordinates,
        properties: location.properties,
      },
      true
    );
    setMobileMenuOpen(false);
    setRailView(null);
  };

  const handleBuildingClick = (building: BuildingInfo): void => {
    setActiveCampusPanel(null);
    openLocation({
      id: building.id,
      name: building.name,
      type: building.type,
      coordinates: building.coordinates,
      properties: building.properties,
    }, true, true);
  };

  const openCampusPanel = (panel: Exclude<CampusPanel, null>): void => {
    closeBottomSheet();
    setMobileMenuOpen(false);
    setRailView(null);
    setActiveCampusPanel((current) => (current === panel ? null : panel));
  };

  const handleCampusRail = (): void => {
    setRailView(null);
    setActiveCampusPanel(null);
    setCategoryRailExpanded(false);
    setMobileMenuOpen(false);
    setActiveFilters([]);
    setShowPowerSupplyOverlay(false);
    setShowFellowships(false);
    setMapViewMode('flat');
    clearRoutePreview();
    closeBottomSheet();
    deselectLocation();
    mapInstance?.flyTo(clientConfig.map.center, clientConfig.map.zoom, { duration: 0.7 });
  };


  const handleToggleMobileMenu = (): void => {
    const nextOpen = !mobileMenuOpen;
    setMobileMenuOpen(nextOpen);
    setRailView(null);

    if (nextOpen) {
      closeBottomSheet();
      setActiveCampusPanel(null);
    }
  };

  const handleCloseMobileMenu = (): void => {
    setMobileMenuOpen(false);
    setRailView(null);
  };

  const handleLocateUser = (): void => {
    if (mapInstance && userLocation) {
      flyToUserLocationWithPopup(mapInstance, userLocation, 17, 0.65);
      return;
    }

    requestGpsAccess();

    if (selectedLocation && !bottomSheetOpen) {
      openBottomSheet();
    }
  };

  const handleShareSOS = async (): Promise<void> => {
    setSosPreparing(true);
    
    if (!userLocation) {
      if (!navigator.geolocation) {
        setSosPreparing(false);
        showWarning('Geolocation is not supported by your browser.', {
          title: 'Location unavailable',
          dedupeKey: 'sos-no-geolocation',
        });
        return;
      }

      // Phase 1: Try with cached location first (lower accuracy, 5s timeout)
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          // Check if user cancelled while we were waiting
          if (!useAppStore.getState().isSosPreparing) return;
          
          setUserLocation([position.coords.latitude, position.coords.longitude]);
          setSosPreparing(false);
          await handleShareSOS(); // Retry now that we have location
          requestGpsAccess();
        },
        () => {
          // Check if user cancelled while we were waiting
          if (!useAppStore.getState().isSosPreparing) return;

          // Phase 2: If Phase 1 fails, try high accuracy with realistic timeout (15s)
          navigator.geolocation.getCurrentPosition(
            async (position) => {
              if (!useAppStore.getState().isSosPreparing) return;
              
              setUserLocation([position.coords.latitude, position.coords.longitude]);
              setSosPreparing(false);
              await handleShareSOS();
              requestGpsAccess();
            },
            () => {
              if (!useAppStore.getState().isSosPreparing) return;
              
              setSosPreparing(false);
              showWarning('Unable to determine your location. Please enable GPS and try again.', {
                title: 'Location required',
                dedupeKey: 'sos-no-location',
              });
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
          );
        },
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
      );
      return;
    }

    try {
      const sessionId = crypto.randomUUID();
      const shareSession = await createLiveShareSession({
        sessionId,
        lat: userLocation[0],
        lng: userLocation[1],
        sos: true,
      });
      const shareUrl = new URL('/map', window.location.origin);
      shareUrl.searchParams.set('live', shareSession.shareToken);
      const shareUrlString = shareUrl.toString();
      const shareText = 'Follow my live location here.';
      const clipboardShareText = `${shareText} ${shareUrlString}`;

      // Start broadcasting
      startBroadcasting(sessionId, shareSession.broadcasterToken);
      
      // Set local intent so broadcaster sees their own marker
      setSharedIntent({
        coordinates: userLocation,
        label: 'My Live SOS',
        isSos: true
      });

      setSosPreparing(false);

      if (navigator.share) {
        try {
          await navigator.share({
            title: 'Live Location Share',
            text: shareText,
            url: shareUrlString,
          });
        } catch (error) {
          // user cancelled or other error
        }
      } else {
        await navigator.clipboard.writeText(clipboardShareText);
        showWarning('SOS message copied to clipboard. Paste it in your messaging app.', {
          title: 'SOS ready',
          dedupeKey: 'sos-clipboard',
        });
      }
    } catch (error) {
      setSosPreparing(false);
      showWarning(error instanceof Error ? error.message : 'Unable to prepare live sharing right now.', {
        title: 'Live share unavailable',
        dedupeKey: 'live-share-create-failed',
      });
    }
  };

  const handleStopBroadcast = (): void => {
    stopBroadcasting();
    setSharedIntent(null);
  };

  const handleLeaveSession = (): void => {
    leaveSession();
    setSharedIntent(null);
  };

  const handleResolveAndJoinLiveSession = useCallback(async (
    liveToken: string,
    options?: { clearUrl?: boolean; source?: 'link' | 'restore' },
  ): Promise<void> => {
    try {
      const resolvedSession = await resolveLiveShareSession(liveToken);

      setSharedIntent({
        coordinates: resolvedSession.coordinates,
        label: 'Shared Live Location',
        isSos: resolvedSession.isSos,
      });

      if (mapInstance) {
        mapInstance.flyTo(resolvedSession.coordinates, 17.5, { duration: 0.8 });
      }

      joinAsViewer(resolvedSession.viewerToken, liveToken, (type) => {
        if (type === 'session_ended') {
          const currentSharedIntent = useAppStore.getState().sharedIntent;
          if (currentSharedIntent) {
            setSharedIntent({ ...currentSharedIntent, isSos: false, label: 'Shared Location (Ended)' });
          }
          showWarning('The live location sharing has been ended by the broadcaster.', {
            title: 'Session Ended',
            dedupeKey: 'live-session-ended',
          });
        } else if (type === 'broadcaster_offline') {
          showWarning('Broadcaster signal lost. Showing last known location.', {
            title: 'Signal Lost',
            dedupeKey: 'live-signal-lost',
          });
        }
      });

      if (options?.source === 'restore') {
        showWarning('Your live viewing session has been restored.', {
          title: 'Live Session Restored',
          dedupeKey: 'live-session-restored',
        });
      }

      if (options?.clearUrl) {
        const params = new URLSearchParams(window.location.search);
        params.delete('live');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
      }
    } catch (error) {
      showWarning(error instanceof Error ? error.message : 'Unable to open the live session.', {
        title: 'Live Session Unavailable',
        dedupeKey: 'live-session-unavailable',
      });
    }
  }, [mapInstance, setSharedIntent, showWarning]);

  const handleReshareLiveLocation = async (): Promise<void> => {
    if (!activeLiveSessionId || !userLocation) return;

    const storedSession = getStoredSOSSession();
    if (!storedSession?.broadcasterToken) return;

    try {
      const shareSession = await createLiveShareSession({
        sessionId: activeLiveSessionId,
        broadcasterToken: storedSession.broadcasterToken,
        lat: userLocation[0],
        lng: userLocation[1],
        sos: true,
      });

      const shareUrl = new URL('/map', window.location.origin);
      shareUrl.searchParams.set('live', shareSession.shareToken);
      const shareUrlString = shareUrl.toString();
      const shareText = 'Follow my live location here.';
      const clipboardShareText = `${shareText} ${shareUrlString}`;

      if (navigator.share) {
        try {
          await navigator.share({
            title: 'Live Location Share',
            text: shareText,
            url: shareUrlString,
          });
        } catch (err) { /* ignore cancel */ }
      } else {
        await navigator.clipboard.writeText(clipboardShareText);
        showWarning('Live location link copied to clipboard.', {
          title: 'Link Copied',
          dedupeKey: 'link-copied-reshare',
        });
      }
    } catch (error) {
      showWarning(error instanceof Error ? error.message : 'Unable to refresh the live-share link.', {
        title: 'Share failed',
        dedupeKey: 'live-share-reshare-failed',
      });
    }
  };

  const handleZoomIn = (): void => {
    mapInstance?.nativeMap.zoomIn({ duration: 250 });
  };

  const handleZoomOut = (): void => {
    mapInstance?.nativeMap.zoomOut({ duration: 250 });
  };

  const handleChangeMapViewMode = (nextMode: MapViewMode): void => {
    if (nextMode === mapViewMode) {
      return;
    }

    if (nextMode === '2_5d' && !enhancedViewAvailable) {
      return;
    }

    setPendingMapViewMode(mapInstance ? nextMode : null);
    setMapViewMode(nextMode);
  };

  const handleOpenMobileMenuView = (view: Exclude<RailView, null>): void => {
    closeBottomSheet();
    setActiveCampusPanel(null);
    setRailView(view);
  };

  const handleOpenMobileLocationDetails = (): void => {
    if (!selectedLocation) {
      return;
    }

    openBottomSheet();
    setMobileMenuOpen(false);
    setRailView(null);
  };

  const handleDismissGpsHint = (): void => {
    setGpsHintDismissed(true);
  };

  const handleRetryGps = (): void => {
    requestGpsAccess();
  };

  const handleToggleRailExpanded = (): void => {
    setRailExpanded((current) => !current);
  };

  const handleToggleRailView = (view: Exclude<RailView, null>): void => {
    const nextView = railView === view ? null : view;
    setRailView(nextView);

    if (nextView) {
      closeBottomSheet();
      deselectLocation();
      setActiveCampusPanel(null);
    }
  };

  const handleSearchActiveChange = useCallback((isActive: boolean): void => {
    const isMobileViewport =
      typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
    const shouldClosePanels = isMobileViewport && isActive;

    if (searchActiveRef.current === shouldClosePanels) {
      return;
    }

    searchActiveRef.current = shouldClosePanels;

    if (shouldClosePanels) {
      closeBottomSheet();
      setActiveCampusPanel(null);
      setRailView(null);
      setMobileMenuOpen(false);
    }
  }, [closeBottomSheet]);

  useEffect(() => {
    userMotionRef.current = userMotion;
  }, [userMotion]);

  useEffect(() => {
    if (followUserLocation) {
      manualCameraOverrideRef.current = false;
    }
  }, [followUserLocation]);

  useEffect(() => {
    if (followUserLocation && userMotion.headingDeg == null && userLocation) {
      return;
    }

    if (typeof userMotion.headingDeg === 'number' && Number.isFinite(userMotion.headingDeg) && userMotion.headingDeg >= 0) {
      navigationBearingRef.current = normalizeBearing(userMotion.headingDeg);
      return;
    }

    if (mapInstance) {
      navigationBearingRef.current = normalizeBearing(mapInstance.nativeMap.getBearing());
    }
  }, [followUserLocation, mapInstance, userLocation, userMotion.headingDeg]);

  const resetNavigationTrackingState = useCallback((): void => {
    etaSamplesRef.current = [];
    motionEtaStateRef.current = createMotionEtaRuntimeState();
    lastGoodOnRoutePreviewRef.current = null;
    offRouteSampleStreakRef.current = 0;
    trackingStatusRef.current = 'on_route';
    routeMatchRef.current = null;
    previousMatchedProgressRef.current = null;
    rerouteStateRef.current = createRerouteState();
    setUserMotion({
      speedMpsInferred: null,
      speedMpsEffective: null,
      state: 'idle',
    });
  }, [setUserMotion]);

  useEffect(() => {
    // no-op: debug logging removed
  }, [mapViewMode]);

  const shouldTriggerAutoReroute = useCallback((location: [number, number]): boolean => {
    if (pendingRouteRequestRef.current) {
      return false;
    }

    const now = Date.now();
    const elapsedMs = now - lastAutoRerouteAtRef.current;
    if (elapsedMs >= AUTO_REROUTE_COOLDOWN_MS) {
      return true;
    }

    const lastLocation = lastAutoRerouteLocationRef.current;
    if (!lastLocation) {
      return false;
    }

    const movedSinceLastAttempt = haversineDistanceMeters(lastLocation, location);

    return movedSinceLastAttempt >= AUTO_REROUTE_MIN_MOVEMENT_M;
  }, []);

  const previewRouteStep = useCallback((stepIndex: number): void => {
    if (!routePreview || routePreview.steps.length === 0) {
      return;
    }

    const safeIndex = Math.min(Math.max(stepIndex, 0), routePreview.steps.length - 1);
    const step = routePreview.steps[safeIndex];
    const startM = step.start_distance_m ?? 0;
    const endM = step.end_distance_m ?? startM + step.distance_m;
    const focusPath = routePathBetweenDistances(routePreview.path, startM, endM);
    if (focusPath.length === 0) {
      return;
    }
    const focusPoint = routePointAtDistance(routePreview.path, startM);
    const bearingDeg = focusPath.length >= 2 ? getBearing(focusPath[0], focusPath[1]) : null;

    setFollowUserLocation(false);
    setRouteStepPreviewIndex(safeIndex);
    setRouteFocusHighlight({
      id: `route_step_preview_${step.id}_${Date.now()}`,
      path: focusPath,
      arrowPath: focusPath,
      point: focusPoint,
      label: step.instruction,
      maneuver: routeFocusManeuver(step),
      bearingDeg,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    if (mapInstance) {
      const bounds = focusPath.reduce<[[number, number], [number, number]]>(
        (currentBounds, point) => [
          [
            Math.min(currentBounds[0][0], point[0]),
            Math.min(currentBounds[0][1], point[1]),
          ],
          [
            Math.max(currentBounds[1][0], point[0]),
            Math.max(currentBounds[1][1], point[1]),
          ],
        ],
        [focusPath[0], focusPath[0]]
      );
      mapInstance.fitBounds(bounds, {
        padding: { top: 180, right: 42, bottom: 150, left: 42 },
        duration: 0.34,
      });
    }
  }, [mapInstance, routePreview, setFollowUserLocation, setRouteFocusHighlight]);

  const closeRouteStepPreview = useCallback((): void => {
    setRouteStepPreviewIndex(null);
    setRouteFocusHighlight(null);
  }, [setRouteFocusHighlight]);

  const activeRouteMatchesSession = Boolean(
    routePreview &&
    selectedLocation &&
    routePreview.destination_id === selectedLocation.id &&
    routePreview.path.length >= 2 &&
    routePreview.routing_mode === routeAccessibilityMode
  );

  useEffect(() => {
    if (!routeFocusHighlight || !routePreview?.steps.length) {
      return;
    }

    const matchedIndex = routePreview.steps.findIndex((step) => (
      routeFocusHighlight.id.includes(`route_step_${step.id}_`) ||
      routeFocusHighlight.label === step.instruction
    ));

    if (matchedIndex >= 0 && routeStepPreviewIndex !== matchedIndex) {
      setRouteStepPreviewIndex(matchedIndex);
    }

    if (matchedIndex >= 0 && !routeFocusHighlight.id.startsWith('route_step_preview_')) {
      previewRouteStep(matchedIndex);
    }
  }, [previewRouteStep, routeFocusHighlight, routePreview, routeStepPreviewIndex]);

  useEffect(() => {
    if (!routePreviewActive || !routePreview) {
      setRouteStepPreviewIndex(null);
    }
  }, [routePreview, routePreviewActive]);

  useEffect(() => {
    const ETA_SMOOTHING_WINDOW = 5;

    if (!routePreviewActive) {
      if (pendingRouteRequestRef.current) {
        runtimeRoutingClient.cancelRoute(pendingRouteRequestRef.current.requestId);
        pendingRouteRequestRef.current = null;
      }

      resetNavigationTrackingState();
      lastRouteSignatureRef.current = '';
      startTransition(() => {
        setRoutePreviewStatus('idle', null);
      });
      return;
    }

    if (!selectedLocation || !userLocation) {
      if (pendingRouteRequestRef.current) {
        runtimeRoutingClient.cancelRoute(pendingRouteRequestRef.current.requestId);
        pendingRouteRequestRef.current = null;
      }

      resetNavigationTrackingState();
      lastRouteSignatureRef.current = '';
      startTransition(() => {
        setRoutePreview(null);
        setRoutePreviewStatus('idle', null);
      });
      return;
    }

    if (!activeRouteMatchesSession || !routePreview) {
      return;
    }

    if (!clientConfig.features.liveTracking) {
      if (routePreviewStatus === 'preparing') {
        startTransition(() => {
          setRoutePreviewStatus('ready', null);
        });
      }
      return;
    }

    let nextPreview: RoutePreview | null = null;
    const activePose = navigationPose;
    const routeMatch = activePose
      ? matchPoseToRoute(activePose, routePreview, routeMatchRef.current)
      : null;
    const rerouteState = activePose
      ? updateRerouteState({
          previousState: rerouteStateRef.current,
          pose: activePose,
          match: routeMatch,
          previousProgressM: previousMatchedProgressRef.current,
          nowMs: Date.now(),
        })
      : rerouteStateRef.current;
    rerouteStateRef.current = rerouteState;
    if (routeMatch) {
      routeMatchRef.current = routeMatch;
      previousMatchedProgressRef.current = routeMatch.progressDistanceM;
    }

    const effectiveLocation = routeMatch && routeMatch.confidence >= 0.45
      ? routeMatch.snappedPoint
      : activePose?.position ?? userLocation;
    const tracking = trackLocationOnRoute(routePreview.path, effectiveLocation);

    if (tracking) {
      const wasOffRoute =
        trackingStatusRef.current === 'off_route' ||
        routePreview.tracking_status === 'off_route';

      let nextTrackingStatus: FixedRouteTrackingStatus = wasOffRoute ? 'off_route' : 'on_route';

      if (wasOffRoute) {
        if (tracking.off_route_distance_m <= OFF_ROUTE_EXIT_THRESHOLD_M) {
          nextTrackingStatus = 'on_route';
          offRouteSampleStreakRef.current = 0;
        }
      } else if (
        tracking.off_route_distance_m > OFF_ROUTE_ENTER_THRESHOLD_M ||
        rerouteState.status === 'suspect' ||
        rerouteState.status === 'confirming'
      ) {
        offRouteSampleStreakRef.current += 1;
        if (offRouteSampleStreakRef.current >= OFF_ROUTE_ENTRY_SAMPLE_COUNT || rerouteState.status === 'confirming') {
          nextTrackingStatus = 'off_route';
        }
      } else {
        offRouteSampleStreakRef.current = 0;
      }

      trackingStatusRef.current = nextTrackingStatus;

      if (nextTrackingStatus === 'on_route') {
        const enriched = enrichRoutePreviewWithTracking(routePreview, effectiveLocation, {
          userMotion,
          etaState: motionEtaStateRef.current,
        });
        motionEtaStateRef.current = enriched.etaState;
        setUserMotion(enriched.userMotionPatch);

        if (enriched.preview.eta_mode === 'live') {
          etaSamplesRef.current = [...etaSamplesRef.current, enriched.rawEtaMin].slice(-ETA_SMOOTHING_WINDOW);
        } else {
          etaSamplesRef.current = [enriched.rawEtaMin];
        }

        const smoothEta = Math.max(
          0,
          Math.round(
            etaSamplesRef.current.reduce((total, value) => total + value, 0) /
              Math.max(1, etaSamplesRef.current.length)
          )
        );

        nextPreview = {
          ...enriched.preview,
          eta_smoothed_min: enriched.preview.eta_mode === 'live' ? smoothEta : enriched.rawEtaMin,
          tracking_status: 'on_route',
          tracking_message: null,
        };
        lastGoodOnRoutePreviewRef.current = nextPreview;
      } else {
        if (rerouteState.status === 'confirming' && shouldTriggerAutoReroute(effectiveLocation)) {
          lastAutoRerouteAtRef.current = Date.now();
          lastAutoRerouteLocationRef.current = [effectiveLocation[0], effectiveLocation[1]];
          rerouteStateRef.current = {
            ...rerouteState,
            status: 'cooldown',
            lastRerouteAtMs: Date.now(),
          };
          lastRouteSignatureRef.current = '';

          startTransition(() => {
            setRoutePreview(null);
            setRoutePreviewStatus('preparing', null);
          });
          return;
        }

        const frozenPreview = lastGoodOnRoutePreviewRef.current ?? routePreview;
        const frozenEta =
          frozenPreview.eta_smoothed_min ??
          frozenPreview.eta_min ??
          routePreview.eta_smoothed_min ??
          routePreview.eta_min;

        etaSamplesRef.current = [frozenEta];
        setUserMotion({
          speedMpsInferred: null,
          speedMpsEffective: null,
          state: 'idle',
        });

        nextPreview = {
          ...routePreview,
          snapped_origin: frozenPreview.snapped_origin ?? routePreview.snapped_origin,
          remaining_path: frozenPreview.remaining_path ?? routePreview.remaining_path ?? routePreview.path,
          remaining_distance_m:
            frozenPreview.remaining_distance_m ??
            routePreview.remaining_distance_m ??
            Math.round(routePreview.distance_m),
          eta_min: frozenPreview.eta_min ?? routePreview.eta_min,
          eta_baseline_min:
            frozenPreview.eta_baseline_min ??
            frozenPreview.eta_min ??
            routePreview.eta_baseline_min ??
            routePreview.eta_min,
          eta_live_min:
            frozenPreview.eta_live_min ??
            frozenPreview.eta_min ??
            routePreview.eta_live_min ??
            routePreview.eta_min,
          eta_mode: 'planned',
          eta_smoothed_min: frozenEta,
          current_step_index:
            frozenPreview.current_step_index ??
            routePreview.current_step_index ??
            0,
          distance_to_next_turn_m:
            frozenPreview.distance_to_next_turn_m ??
            routePreview.distance_to_next_turn_m ??
            0,
          off_route_distance_m: Math.round(tracking.off_route_distance_m),
          tracking_status: 'off_route',
          tracking_message: OFF_ROUTE_MESSAGE,
        };
      }
    } else {
      nextPreview = {
        ...routePreview,
        tracking_status: trackingStatusRef.current,
        tracking_message: trackingStatusRef.current === 'off_route' ? OFF_ROUTE_MESSAGE : null,
      };
    }

    if (!nextPreview) {
      return;
    }

    const displayPath = nextPreview.remaining_path ?? nextPreview.path;
    const pathHead = displayPath[0] ?? nextPreview.path[0];
    const signature = `${nextPreview.destination_id}_${nextPreview.routing_mode ?? 'standard'}_${nextPreview.tracking_status ?? 'on_route'}_${nextPreview.off_route_distance_m ?? 0}_${nextPreview.eta_smoothed_min ?? nextPreview.eta_min}_${nextPreview.remaining_distance_m ?? nextPreview.distance_m}_${nextPreview.current_step_index ?? 0}_${nextPreview.distance_to_next_turn_m ?? 0}_${pathHead?.[0] ?? 0}_${pathHead?.[1] ?? 0}_${effectiveLocation[0].toFixed(6)}_${effectiveLocation[1].toFixed(6)}_${Math.round(rerouteState.deviationScore * 100)}`;

    if (signature === lastRouteSignatureRef.current) {
      return;
    }

    lastRouteSignatureRef.current = signature;
    startTransition(() => {
      setRoutePreview(nextPreview);
      if (routePreviewStatus === 'preparing') {
        setRoutePreviewStatus('ready', null);
      }
    });
  }, [
    activeRouteMatchesSession,
    resetNavigationTrackingState,
    routePreview,
    routePreviewActive,
    routePreviewStatus,
    selectedLocation,
    setRoutePreview,
    setRoutePreviewStatus,
    setUserMotion,
    shouldTriggerAutoReroute,
    navigationPose,
    userMotion,
    userLocation,
  ]);

  useEffect(() => {
    if (!routePreviewActive || !selectedLocation || !userLocation) {
      return;
    }

    if (activeRouteMatchesSession && routePreviewStatus !== 'preparing') {
      return;
    }

    const routeOrigin = navigationPose?.position ?? userLocation;
    const runtimeStillPreparing =
      !routingRuntimeAvailable &&
      (routingState === 'idle' || routingState === 'loading' || routingState === 'processing');

    if (runtimeStillPreparing) {
      if (activeRouteMatchesSession && routePreviewStatus === 'preparing') {
        return;
      }

      if (pendingRouteRequestRef.current) {
        runtimeRoutingClient.cancelRoute(pendingRouteRequestRef.current.requestId);
        pendingRouteRequestRef.current = null;
      }

      resetNavigationTrackingState();
      lastRouteSignatureRef.current = '';
      startTransition(() => {
        setRoutePreview(null);
        setRoutePreviewStatus('preparing', null);
      });
      return;
    }

    const requestKey = `${selectedLocation.id}:${routeAccessibilityMode}`;
    if (pendingRouteRequestRef.current?.key === requestKey) {
      return;
    }

    if (pendingRouteRequestRef.current) {
      runtimeRoutingClient.cancelRoute(pendingRouteRequestRef.current.requestId);
    }

    resetNavigationTrackingState();
    lastRouteSignatureRef.current = '';

    startTransition(() => {
      setRoutePreview(null);
      setRoutePreviewStatus('preparing', null);
    });

    const { requestId, promise } = runtimeRoutingClient.buildExactRoute({
      origin: routeOrigin,
      destination: selectedLocation.coordinates,
      destinationId: selectedLocation.id,
      accessibilityMode: routeAccessibilityMode,
    });

    pendingRouteRequestRef.current = {
      key: requestKey,
      requestId,
    };

    let cancelled = false;

    promise
      .then((rebuiltPreview) => {
        if (cancelled || pendingRouteRequestRef.current?.requestId !== requestId) {
          return;
        }

        pendingRouteRequestRef.current = null;
        const latestOrigin = useAppStore.getState().navigationPose?.position ?? useAppStore.getState().userLocation ?? routeOrigin;
        const trackedPreview = enrichRoutePreviewWithTracking(rebuiltPreview, latestOrigin, {
          userMotion: userMotionRef.current,
          etaState: motionEtaStateRef.current,
        });

        motionEtaStateRef.current = trackedPreview.etaState;
        setUserMotion(trackedPreview.userMotionPatch);
        etaSamplesRef.current = [trackedPreview.rawEtaMin];

        const nextPreview: RoutePreview = {
          ...trackedPreview.preview,
          eta_smoothed_min: trackedPreview.rawEtaMin,
          tracking_status: 'on_route',
          tracking_message: null,
        };

        lastGoodOnRoutePreviewRef.current = nextPreview;

        startTransition(() => {
          setRoutePreview(nextPreview);
          setRoutePreviewStatus('ready', null);
        });
      })
      .catch((error) => {
        if (cancelled || pendingRouteRequestRef.current?.requestId !== requestId) {
          return;
        }

        pendingRouteRequestRef.current = null;
        const fallbackPreview = buildCampusRoutePreview({
          origin: routeOrigin,
          destination: selectedLocation.coordinates,
          destinationId: selectedLocation.id,
          graph: null,
          accessibilityMode: routeAccessibilityMode,
          locations: geojsonData ?? null,
        });
        const trackedPreview = enrichRoutePreviewWithTracking(fallbackPreview, routeOrigin, {
          userMotion: userMotionRef.current,
          etaState: motionEtaStateRef.current,
        });

        motionEtaStateRef.current = trackedPreview.etaState;
        setUserMotion(trackedPreview.userMotionPatch);
        etaSamplesRef.current = [trackedPreview.rawEtaMin];

        const nextPreview: RoutePreview = {
          ...trackedPreview.preview,
          eta_smoothed_min: trackedPreview.rawEtaMin,
          tracking_status: 'on_route',
          tracking_message: null,
        };

        lastGoodOnRoutePreviewRef.current = nextPreview;

        const message =
          error instanceof Error
            ? error.message
            : 'Navigation is using a simplified direct path while the routing runtime recovers.';

        showWarning('Navigation is using a simplified direct path while the routing runtime recovers.', {
          title: 'Routing fallback',
          dedupeKey: `route-worker-fallback-${requestKey}`,
        });

        startTransition(() => {
          setRoutePreview(nextPreview);
          setRoutePreviewStatus('error', message);
        });
      });

    return () => {
      cancelled = true;
      runtimeRoutingClient.cancelRoute(requestId);
      if (pendingRouteRequestRef.current?.requestId === requestId) {
        pendingRouteRequestRef.current = null;
      }
    };
  }, [
    activeRouteMatchesSession,
    geojsonData,
    resetNavigationTrackingState,
    navigationPose,
    routeAccessibilityMode,
    routePreviewStatus,
    routePreviewActive,
    routingRuntimeAvailable,
    routingState,
    selectedLocation,
    setRoutePreview,
    setRoutePreviewStatus,
    setUserMotion,
    showWarning,
    userLocation,
  ]);

  useEffect((): (() => void) | void => {
    if (!clientConfig.features.liveTracking || !mapInstance) {
      return;
    }

    const nativeMap = mapInstance.nativeMap;
    const handleManualCameraInteraction = (event?: { originalEvent?: Event }): void => {
      if (!followUserLocation || !routePreviewActive) {
        return;
      }

      if (event && 'originalEvent' in event && !event.originalEvent) {
        return;
      }

      const userInitiatedInteraction = Boolean(event?.originalEvent);
      if (programmaticCameraTokenRef.current > 0 && !userInitiatedInteraction) {
        return;
      }

      if (userInitiatedInteraction && programmaticCameraTokenRef.current > 0) {
        if (programmaticCameraReleaseTimeoutRef.current !== null) {
          window.clearTimeout(programmaticCameraReleaseTimeoutRef.current);
          programmaticCameraReleaseTimeoutRef.current = null;
        }
        programmaticCameraTokenRef.current = 0;
        if ('stop' in nativeMap && typeof nativeMap.stop === 'function') {
          nativeMap.stop();
        }
      }

      manualCameraOverrideRef.current = true;
      setFollowUserLocation(false);
    };

    nativeMap.on('dragstart', handleManualCameraInteraction);
    nativeMap.on('rotatestart', handleManualCameraInteraction);
    nativeMap.on('pitchstart', handleManualCameraInteraction);
    nativeMap.on('zoomstart', handleManualCameraInteraction);

    return (): void => {
      nativeMap.off('dragstart', handleManualCameraInteraction);
      nativeMap.off('rotatestart', handleManualCameraInteraction);
      nativeMap.off('pitchstart', handleManualCameraInteraction);
      nativeMap.off('zoomstart', handleManualCameraInteraction);
    };
  }, [followUserLocation, mapInstance, routePreviewActive, setFollowUserLocation]);

  useEffect(() => {
    if (
      !clientConfig.features.liveTracking ||
      !mapInstance ||
      !followUserLocation ||
      !routePreviewActive ||
      !userLocation ||
      !routePreview ||
      manualCameraOverrideRef.current
    ) {
      navigationCameraRef.current = null;
      navigationCameraTargetRef.current = null;
      if (navigationCameraFrameRef.current !== null) {
        window.cancelAnimationFrame(navigationCameraFrameRef.current);
        navigationCameraFrameRef.current = null;
      }
      if (mapInstance && (!followUserLocation || !routePreviewActive)) {
        navigationBearingRef.current = normalizeBearing(mapInstance.nativeMap.getBearing());
      }
      return;
    }

    const remainingPath =
      routePreview.remaining_path && routePreview.remaining_path.length >= 2
        ? routePreview.remaining_path
        : routePreview.path;

    if (remainingPath.length < 2) {
      return;
    }

    const nativeMap = mapInstance.nativeMap;
    const currentCenter = nativeMap.getCenter();
    const currentZoom = nativeMap.getZoom();
    const currentPitch = nativeMap.getPitch();

    const cameraLocation = navigationPose?.snappedPosition ?? navigationPose?.position ?? userLocation;
    const targetCamera = buildNavigationCameraTarget({
      location: cameraLocation,
      remainingPath,
      deviceHeading: userMotion.headingDeg,
      previousBearing: navigationBearingRef.current,
      currentZoom,
      currentPitch,
      distanceToNextTurnM: routePreview.distance_to_next_turn_m,
      remainingDistanceM: routePreview.remaining_distance_m ?? routePreview.distance_m,
      speedMps:
        userMotion.speedMpsEffective ??
        userMotion.speedMpsRaw ??
        userMotion.speedMpsInferred ??
        0,
      viewMode: mapViewMode,
    });

    navigationBearingRef.current = targetCamera.bearing;
    navigationCameraTargetRef.current = targetCamera;

    if (!navigationCameraRef.current) {
      navigationCameraRef.current = {
        center: [currentCenter.lat, currentCenter.lng],
        bearing: normalizeBearing(nativeMap.getBearing()),
        zoom: currentZoom,
        pitch: currentPitch,
      };
    }

    if (navigationCameraFrameRef.current !== null) {
      return;
    }

    programmaticCameraTokenRef.current += 1;
    lastNavigationCameraFrameAtRef.current = 0;

    const stepCamera = (timestamp: number): void => {
      if (
        !followUserLocation ||
        !routePreviewActive ||
        manualCameraOverrideRef.current ||
        !navigationCameraTargetRef.current
      ) {
        navigationCameraFrameRef.current = null;
        navigationCameraTargetRef.current = null;
        navigationCameraRef.current = null;
        programmaticCameraTokenRef.current = Math.max(0, programmaticCameraTokenRef.current - 1);
        return;
      }

      const previousTimestamp = lastNavigationCameraFrameAtRef.current || timestamp;
      lastNavigationCameraFrameAtRef.current = timestamp;
      const frameScale = Math.min(3, Math.max(0.5, (timestamp - previousTimestamp) / 16.67));
      const target = navigationCameraTargetRef.current;
      const current = navigationCameraRef.current ?? {
        center: [nativeMap.getCenter().lat, nativeMap.getCenter().lng] as [number, number],
        bearing: normalizeBearing(nativeMap.getBearing()),
        zoom: nativeMap.getZoom(),
        pitch: nativeMap.getPitch(),
      };
      const distanceToTargetM = haversineDistanceMeters(current.center, target.center);
      const centerFactor = Math.min(0.55, (distanceToTargetM > 24 ? 0.26 : 0.18) * frameScale);
      const bearingFactor = Math.min(0.5, 0.2 * frameScale);
      const zoomFactor = Math.min(0.36, 0.12 * frameScale);
      const pitchFactor = Math.min(0.36, 0.12 * frameScale);
      const nextCamera: NavigationCameraState = {
        center: lerpLocation(current.center, target.center, centerFactor),
        bearing: normalizeBearing(current.bearing + shortestAngleDelta(current.bearing, target.bearing) * bearingFactor),
        zoom: lerp(current.zoom, target.zoom, zoomFactor),
        pitch: lerp(current.pitch, target.pitch, pitchFactor),
      };

      navigationCameraRef.current = nextCamera;
      nativeMap.jumpTo({
        center: [nextCamera.center[1], nextCamera.center[0]],
        bearing: nextCamera.bearing,
        zoom: nextCamera.zoom,
        pitch: nextCamera.pitch,
      });

      navigationCameraFrameRef.current = window.requestAnimationFrame(stepCamera);
    };

    navigationCameraFrameRef.current = window.requestAnimationFrame(stepCamera);

    return () => {
      if (
        !followUserLocation ||
        !routePreviewActive ||
        manualCameraOverrideRef.current ||
        !routePreview
      ) {
        if (navigationCameraFrameRef.current !== null) {
          window.cancelAnimationFrame(navigationCameraFrameRef.current);
          navigationCameraFrameRef.current = null;
        }
        navigationCameraTargetRef.current = null;
        navigationCameraRef.current = null;
        programmaticCameraTokenRef.current = 0;
      }
    };
  }, [followUserLocation, mapInstance, mapViewMode, navigationPose, routePreview, routePreviewActive, userLocation, userMotion]);

  useEffect((): void => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const locationId = params.get('location')?.trim() || '';
    const liveTokenParam = params.get('live')?.trim() || '';
    const latStr = params.get('lat');
    const lngStr = params.get('lng');
    const sosParam = params.get('sos');
    const liveSessionParam = params.get('live_session');

    if (liveTokenParam && handledSharedIntentRef.current !== liveTokenParam) {
      handledSharedIntentRef.current = liveTokenParam;
      void handleResolveAndJoinLiveSession(liveTokenParam, { clearUrl: true, source: 'link' });
      return;
    }

    const storedViewerLiveToken = getStoredViewerLiveToken();
    if (!liveTokenParam && storedViewerLiveToken && handledSharedIntentRef.current !== `stored:${storedViewerLiveToken}` && !activeLiveSessionId) {
      handledSharedIntentRef.current = `stored:${storedViewerLiveToken}`;
      void handleResolveAndJoinLiveSession(storedViewerLiveToken, { source: 'restore' });
      return;
    }

    // Legacy live session links (kept as fallback)
    if (liveSessionParam && handledSharedIntentRef.current !== liveSessionParam) {
      handledSharedIntentRef.current = liveSessionParam;

      const initialLat = latStr ? parseFloat(latStr) : 0;
      const initialLng = lngStr ? parseFloat(lngStr) : 0;

      setSharedIntent({
        coordinates: [initialLat, initialLng],
        label: 'Shared Live Location',
        isSos: true,
      });

      if (mapInstance && !isNaN(initialLat) && !isNaN(initialLng) && initialLat !== 0) {
        mapInstance.flyTo([initialLat, initialLng], 17.5, { duration: 0.8 });
      }
      return;
    }

    // Handle coordinates intent (SOS/Shared)
    if (latStr && lngStr) {
      const lat = parseFloat(latStr);
      const lng = parseFloat(lngStr);
      const isSos = sosParam === 'true';
      const signature = `${lat},${lng},${isSos}`;

      if (!isNaN(lat) && !isNaN(lng) && handledSharedIntentRef.current !== signature) {
        handledSharedIntentRef.current = signature;
        setSharedIntent({
          coordinates: [lat, lng],
          label: isSos ? 'SOS Alert' : 'Shared Location',
          isSos,
        });

        if (mapInstance) {
          mapInstance.flyTo([lat, lng], 17.5, { duration: 0.8 });
        }

        params.delete('lat');
        params.delete('lng');
        params.delete('sos');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
        return;
      }
    }

    // Handle POI/Building intent
    if (buildings.length === 0 || !locationId || handledLocationIntentRef.current === locationId) {
      return;
    }

    const matchedLocation = buildings.find((building) => building.id === locationId);

    if (!matchedLocation) {
      return;
    }

    handledLocationIntentRef.current = locationId;
    openLocation(
      {
        id: matchedLocation.id,
        name: matchedLocation.name,
        type: matchedLocation.type,
        coordinates: matchedLocation.coordinates,
        properties: matchedLocation.properties,
      },
      true,
      true
    );

    params.delete('location');
    params.delete('source');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }, [activeLiveSessionId, buildings, handleResolveAndJoinLiveSession, mapInstance, openLocation, setSharedIntent]);

  const railItems = railView === 'favourite' ? favouriteLocations : recentLocations;
  const visibleRailItems = railView === 'recent' ? railItems.slice(0, 5) : railItems.slice(0, 8);
  const visibleNotificationEvents = notificationEvents.slice(0, 8);
  const unreadNotificationCount = notificationEvents.filter(
    (event) => event.createdAt > notificationFeedSeenAt
  ).length;
  const hasUnreadAlerts = unreadNotificationCount > 0;
  const showRailListPanel = railView !== null;

  const locationDetailsOpen = Boolean(selectedLocation);
  const fellowshipSearchActive = Boolean(selectedLocation?.fellowshipFocusCode);
  const shouldShowCampusPanel = !locationDetailsOpen && activeCampusPanel !== null;
  const mobileLiveSessionVisible = Boolean(sharedIntent);
  const mobileControlsHidden = mobileMenuOpen || shouldShowCampusPanel;
  const mobileZoomBottomPx = mobileLiveSessionVisible ? MOBILE_ZOOM_BOTTOM_WITH_LIVE_PX : MOBILE_ZOOM_BOTTOM_PX;
  const mobileLocateBottomPx = mobileLiveSessionVisible ? MOBILE_LOCATE_BOTTOM_WITH_LIVE_PX : MOBILE_LOCATE_BOTTOM_PX;
  const mobileOpenLayersBottomPx = mobileLiveSessionVisible
    ? MOBILE_OPEN_LAYERS_BOTTOM_WITH_LIVE_PX
    : MOBILE_OPEN_LAYERS_BOTTOM_PX;
  const mobileOpenLayersRightPx = mobileLiveSessionVisible
    ? MOBILE_OPEN_LAYERS_RIGHT_WITH_LIVE_PX
    : MOBILE_OPEN_LAYERS_RIGHT_PX;
  const liveSessionStatusTone = liveConnectionState === 'connected'
    ? 'bg-rose-100 text-rose-700'
    : liveConnectionState === 'offline' || liveConnectionState === 'rejected'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-slate-100 text-slate-700';
  const liveSessionStatusLabel = isBroadcastingLive
    ? liveConnectionState === 'connected'
      ? 'Sharing live'
      : liveConnectionState === 'offline'
        ? 'Offline'
        : liveConnectionState === 'rejected'
          ? 'Rejected'
          : 'Connecting'
    : activeLiveSessionId
      ? liveConnectionState === 'connected'
        ? 'Viewing live'
        : liveConnectionState === 'offline'
          ? 'Offline'
          : liveConnectionState === 'rejected'
            ? 'Rejected'
            : 'Reconnecting'
      : 'Ready';
  const liveMenuTitle = isBroadcastingLive
    ? 'Your live share'
    : activeLiveSessionId
      ? 'Live session'
      : 'Live sharing';
  const liveMenuDescription = isBroadcastingLive
    ? 'Share your current route with a protected live link and monitor the session in one place.'
    : activeLiveSessionId
      ? 'Stay on top of live session status, reconnect progress, and sharing controls.'
      : 'Start a protected live share and manage the session from a dedicated panel.';
  const liveSessionTitle =
    activeLiveSessionId && (isBroadcastingLive || sharedIntent?.isSos)
      ? isBroadcastingLive
        ? liveConnectionState === 'connected'
          ? 'Live Location Active'
          : liveConnectionState === 'rejected'
            ? 'Live Location Rejected'
          : liveConnectionState === 'offline'
            ? 'Live Location Offline'
            : 'Connecting Live Location'
        : liveConnectionState === 'connected'
          ? 'Viewing Live Location'
          : liveConnectionState === 'rejected'
            ? 'Live Session Rejected'
          : liveConnectionState === 'offline'
            ? 'Viewer Disconnected'
            : 'Reconnecting to Live Location'
      : sharedIntent?.label ?? '';
  const primaryCategory = categoryList.find((category) => (
    !isPowerSupplyFilter(category) && category.toLowerCase().includes('building')
  )) ?? categoryList.find((category) => !isPowerSupplyFilter(category));
  const quickFilterVisible = !locationDetailsOpen;
  const collapsedCategoryList = [
    ...(primaryCategory ? [primaryCategory] : []),
  ];
  const expandedCategoryList = categoryList.filter((category) => !isPowerSupplyFilter(category));
  const visibleCategoryRail = categoryRailExpanded ? expandedCategoryList : collapsedCategoryList;
  const hasMoreCategories = expandedCategoryList.length > collapsedCategoryList.length;
  const quickFilterButtonClass = (active: boolean): string => (
    `whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold leading-none transition ${
      active
        ? 'border-slate-900 bg-slate-900 text-white shadow-[0_6px_18px_rgba(15,23,42,0.14)]'
        : 'border-white/80 bg-white/95 text-slate-800 shadow-[0_8px_20px_rgba(15,23,42,0.12)] hover:border-slate-300'
    }`
  );

  useEffect(() => {
    if (!pendingMapViewMode || !mapInstance) {
      return;
    }

    const nativeMap = mapInstance.nativeMap;
    let settled = false;

    const finishTransition = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      setPendingMapViewMode((current) => (current === pendingMapViewMode ? null : current));
    };

    nativeMap.once('moveend', finishTransition);
    nativeMap.once('idle', finishTransition);
    const timeoutId = window.setTimeout(finishTransition, 1400);

    return () => {
      window.clearTimeout(timeoutId);
      nativeMap.off('moveend', finishTransition);
      nativeMap.off('idle', finishTransition);
    };
  }, [mapInstance, pendingMapViewMode]);

  const openRailNotification = (event: NotificationFeedEvent): void => {
    const matchedLocation = buildings.find((building) => building.id === event.locationId);

    if (!matchedLocation) {
      setMobileMenuOpen(false);
      setRailView(null);
      return;
    }

    openLocation(
      {
        id: matchedLocation.id,
        name: matchedLocation.name,
        type: matchedLocation.type,
        coordinates: matchedLocation.coordinates,
        properties: matchedLocation.properties,
      },
      true,
      true
    );
    markNotificationFeedSeen();
    setMobileMenuOpen(false);
    setRailView(null);
  };

  useEffect(() => {
    if (railView === 'alerts') {
      markNotificationFeedSeen();
    }
  }, [markNotificationFeedSeen, railView]);

  useEffect(() => {
    if (!clientConfig.features.powerStatus || !mapInstance) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setPowerStatusEnabled(true);
    }, 1200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [mapInstance]);

  return (
    <main className="relative flex-1 overflow-hidden">
      <div className="map-shell absolute inset-0 bg-slate-900">
        <MapEngine
          onMapReady={onMapReady}
          height="h-full"
          viewMode={mapViewMode}
        />

        {mapInstance && geojsonData && (
          <LocationOutlineLayer
            map={mapInstance}
            geojsonData={geojsonData}
            dimAcademic={showFellowships}
            viewMode={mapViewMode}
          />
        )}

        {mapInstance && geojsonData && (
          <FellowshipLayer
            map={mapInstance}
            geojsonData={geojsonData}
            enabled={showFellowships || fellowshipSearchActive}
            showAll={showFellowships}
            onSelectFellowship={(selection) => openLocation(selection, true, true)}
          />
        )}

        {mapInstance && routingData && (
          <GateLayer
            map={mapInstance}
            routingData={routingData}
            routePreview={routePreviewActive ? routePreview : null}
          />
        )}

        {mapInstance && (
          <RoutePreviewLayer
            map={mapInstance}
            routePreview={routePreviewActive ? routePreview : null}
            routingData={routingData ?? null}
            focusHighlight={routeFocusHighlight}
          />
        )}

        {mapInstance && geojsonData && (
          <MarkerLayer map={mapInstance} geojsonData={geojsonData} dimAcademic={showFellowships} />
        )}

        <NavigationFeedbackLayer
          routePreviewActive={routePreviewActive}
          routePreview={routePreview}
          selectedLocation={selectedLocation}
          userLocation={userLocation}
          userMotion={userMotion}
          geojsonData={geojsonData ?? null}
          routeAccessibilityMode={routeAccessibilityMode}
          onArrive={clearRoutePreview}
        />

        {powerStatusEnabled && (
          <Suspense
            fallback={
              <div className="pointer-events-none absolute right-3 top-20 hidden md:block">
                <div className="loading-shimmer h-12 w-40 rounded-2xl border border-white/70 bg-white/80 shadow-[0_18px_42px_rgba(15,23,42,0.16)] backdrop-blur" />
              </div>
            }
          >
            <PowerStatusLayer selectedLocationId={selectedLocation?.id ?? null} />
          </Suspense>
        )}

        {mapInstance && geojsonData && clientConfig.features.powerStatus && (
          <PowerSupplyOverlayLayer
            map={mapInstance}
            geojsonData={geojsonData}
            enabled={showPowerSupplyOverlay}
            onSelectLocation={(selection) => openLocation(selection, true, true)}
          />
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-slate-900/25" />
      </div>

      <div className="pointer-events-none absolute inset-0 z-20">
        {shouldShowGpsHint && (
          <div className="pointer-events-none absolute inset-x-3 bottom-24 z-30 lg:hidden">
            <div className="pointer-events-auto mx-auto max-w-[520px] rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900 shadow-[0_14px_30px_rgba(15,23,42,0.18)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">GPS alert</p>
                  <p className="mt-1 text-sm font-semibold">{gpsGuidance.title}</p>
                  <p className="mt-1 text-xs font-medium">{gpsGuidance.summary}</p>
                </div>
                <button
                  type="button"
                  onClick={handleDismissGpsHint}
                  aria-label="Dismiss GPS alert"
                  className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-xs font-semibold text-amber-800"
                >
                  x
                </button>
              </div>
              {gpsGuidance.canRetry && (
                <button
                  type="button"
                  onClick={handleRetryGps}
                  className="mt-2 rounded-full border border-amber-300 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-800"
                >
                  Retry GPS
                </button>
              )}
            </div>
          </div>
        )}

        <AnimatePresence>
          {routeStepPreviewOpen && routePreview && selectedRouteStep && (
            <motion.section
              key="route-step-preview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto fixed inset-0 z-[70] bg-transparent lg:hidden"
            >
              <div className="absolute inset-x-2 top-2 overflow-hidden rounded-[24px] border border-white/80 bg-white/95 text-slate-950 shadow-[0_18px_42px_rgba(15,23,42,0.18)] backdrop-blur">
                <div className="flex h-12 items-center justify-between border-b border-slate-100 px-2.5">
                  <span className="h-9 w-9" aria-hidden="true" />
                  <h2 className="font-['Outfit'] text-base font-semibold">Route preview</h2>
                  <button
                    type="button"
                    onClick={closeRouteStepPreview}
                    className="grid h-9 w-9 place-items-center rounded-full text-slate-600 transition hover:bg-rose-50 hover:text-rose-600"
                    aria-label="Cancel route preview"
                  >
                    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden="true">
                      <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>

                <div className="flex items-center gap-3 px-4 py-4">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-cyan-50 text-cyan-700">
                    <svg viewBox="0 0 24 24" className="h-9 w-9" aria-hidden="true">
                      {routeManeuver === 'left' ? (
                        <path d="M19 19v-8a4 4 0 0 0-4-4H7m4-4-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      ) : routeManeuver === 'right' ? (
                        <path d="M5 19v-8a4 4 0 0 1 4-4h8m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      ) : routeManeuver === 'uturn' ? (
                        <path d="M17 18V8.5a4.5 4.5 0 0 0-9 0V19m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                      ) : (
                        <path d="M12 20V5m0 0-5 5m5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      )}
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{formatNavigationDistance(selectedRouteStep.distance_m)}</p>
                    <p className="mt-1 line-clamp-2 font-['Outfit'] text-xl font-semibold leading-6 text-slate-950">{selectedRouteStepInstruction}</p>
                  </div>
                </div>
              </div>

              <div className="absolute bottom-5 right-5 flex overflow-hidden rounded-[18px] border border-white/80 bg-white/95 shadow-[0_16px_34px_rgba(15,23,42,0.2)] backdrop-blur">
                <button
                  type="button"
                  onClick={() => previewRouteStep(selectedRouteStepIndex - 1)}
                  disabled={selectedRouteStepIndex <= 0}
                  className="grid h-11 w-11 place-items-center border-r border-slate-100 text-slate-700 transition hover:bg-cyan-50 hover:text-cyan-700 disabled:cursor-not-allowed disabled:text-slate-300"
                  aria-label="Previous route step"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => previewRouteStep(selectedRouteStepIndex + 1)}
                  disabled={!routePreview || selectedRouteStepIndex >= routePreview.steps.length - 1}
                  className="grid h-11 w-11 place-items-center text-slate-700 transition hover:bg-cyan-50 hover:text-cyan-700 disabled:cursor-not-allowed disabled:text-slate-300"
                  aria-label="Next route step"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {!mobileControlsHidden && (
          <>
            <div
              className="pointer-events-none absolute right-3 z-30 flex flex-col gap-2 lg:hidden"
              style={{ bottom: `${mobileZoomBottomPx}px` }}
            >
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={!mapInstance}
                className="pointer-events-auto grid h-9 w-9 place-items-center rounded-[14px] border border-slate-200 bg-white text-slate-700 shadow-[0_10px_22px_rgba(15,23,42,0.14)] transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                aria-label="Zoom in"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={!mapInstance}
                className="pointer-events-auto grid h-9 w-9 place-items-center rounded-[14px] border border-slate-200 bg-white text-slate-700 shadow-[0_10px_22px_rgba(15,23,42,0.14)] transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                aria-label="Zoom out"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <button
              type="button"
              onClick={handleLocateUser}
              className="mobile-bottom-dock pointer-events-auto absolute right-3 z-30 grid h-9 w-9 place-items-center rounded-[18px] border border-[rgba(8,145,178,0.2)] bg-white text-[var(--wia-primary)] shadow-[0_14px_28px_rgba(8,145,178,0.2)] transition hover:border-[rgba(8,145,178,0.22)] hover:bg-white/90 sm:right-4 lg:hidden"
              style={{ bottom: `${mobileLocateBottomPx}px` }}
              aria-label={userLocation ? 'Center on current location' : 'Request current location'}
              title={userLocation ? 'Current location' : 'Enable current location'}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                <circle cx="12" cy="12" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.9" fill="currentColor" />
                <path d="M12 2.75v3.1M12 18.15v3.1M2.75 12h3.1M18.15 12h3.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}

        <div
          className="pointer-events-none absolute right-5 hidden lg:flex"
          style={{ bottom: `${DESKTOP_ZOOM_BOTTOM_PX}px` }}
        >
          <div className="pointer-events-auto inline-flex flex-col gap-2 rounded-[22px] border border-white/80 bg-white/94 p-2 shadow-[0_18px_38px_rgba(15,23,42,0.2)] backdrop-blur">
            <button
              type="button"
              onClick={handleLocateUser}
              className="grid h-10 w-10 place-items-center rounded-2xl border border-[rgba(8,145,178,0.16)] bg-white text-[var(--wia-primary)] transition hover:border-[rgba(8,145,178,0.24)] hover:bg-cyan-50/60 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={userLocation ? 'Center on current location' : 'Request current location'}
              title={userLocation ? 'Current location' : 'Enable current location'}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <circle cx="12" cy="12" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.9" fill="currentColor" />
                <path d="M12 2.75v3.1M12 18.15v3.1M2.75 12h3.1M18.15 12h3.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>

            <button
              type="button"
              onClick={handleZoomIn}
              disabled={!mapInstance}
              className="grid h-10 w-10 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label="Zoom in"
              title="Zoom in"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={!mapInstance}
              className="grid h-10 w-10 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label="Zoom out"
              title="Zoom out"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <AnimatePresence>
          {sharedIntent && (
            <motion.div
              initial={{ opacity: 0, y: 100, x: '-50%' }}
              animate={{ opacity: 1, y: 0, x: '-50%' }}
              exit={{ opacity: 0, y: 100, x: '-50%' }}
              className="pointer-events-auto fixed bottom-6 left-1/2 z-[60] w-[calc(100%-32px)] max-w-sm rounded-3xl border border-white/40 bg-white/80 p-4 shadow-[0_20px_50px_rgba(0,0,0,0.2)] backdrop-blur-xl"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${sharedIntent.isSos ? 'bg-rose-500' : 'bg-cyan-500'}`}>
                    <svg viewBox="0 0 24 24" className="h-6 w-6 text-white" aria-hidden="true">
                      {sharedIntent.isSos ? (
                        <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      ) : (
                        <path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      )}
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {liveSessionTitle}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                      {activeLiveSessionId && isBroadcastingLive && liveConnectionState === 'connected' && (
                        <div className="flex items-center gap-1.5">
                          <span className="flex h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                          <p className="text-[11px] font-bold text-rose-600 uppercase tracking-wider">
                            {liveViewerCount} {liveViewerCount === 1 ? 'viewer' : 'viewers'}
                          </p>
                        </div>
                      )}
                      
                      {activeLiveSessionId && isBroadcastingLive && liveConnectionState === 'connected' && liveGpsAccuracy !== null && (
                        <div className="flex items-center gap-1.5">
                          <div className="flex items-end gap-0.5 h-3">
                            <div className={`w-0.5 rounded-t-sm bg-current ${liveGpsAccuracy < 100 ? 'text-emerald-500' : 'text-slate-300'} h-1`} />
                            <div className={`w-0.5 rounded-t-sm bg-current ${liveGpsAccuracy < 40 ? 'text-emerald-500' : 'text-slate-300'} h-2`} />
                            <div className={`w-0.5 rounded-t-sm bg-current ${liveGpsAccuracy < 15 ? 'text-emerald-500' : 'text-slate-300'} h-3`} />
                          </div>
                          <p className={`text-[10px] font-bold uppercase tracking-wider ${liveGpsAccuracy < 40 ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {liveGpsAccuracy < 15 ? 'Strong' : liveGpsAccuracy < 40 ? 'Fair' : 'Weak'} Signal
                          </p>
                        </div>
                      )}

                      {activeLiveSessionId && isBroadcastingLive && liveConnectionState !== 'connected' && (
                        <p className={`text-[10px] font-bold uppercase tracking-wider ${
                          liveConnectionState === 'rejected'
                            ? 'text-rose-700'
                            : 
                          liveConnectionState === 'offline' ? 'text-rose-600' : 'text-amber-600'
                        }`}>
                          {liveConnectionState === 'rejected'
                            ? 'Server rejected this session'
                            : liveConnectionState === 'offline'
                              ? 'No internet connection'
                              : 'Waiting for network'}
                        </p>
                      )}

                      {activeLiveSessionId && !isBroadcastingLive && liveConnectionState !== 'connected' && (
                        <p className={`text-[10px] font-bold uppercase tracking-wider ${
                          liveConnectionState === 'rejected'
                            ? 'text-rose-700'
                            :
                          liveConnectionState === 'offline' ? 'text-rose-600' : 'text-amber-600'
                        }`}>
                          {liveConnectionState === 'rejected'
                            ? 'Access rejected'
                            : liveConnectionState === 'offline'
                              ? 'Viewer offline'
                              : 'Reconnecting to sharer'}
                        </p>
                      )}

                      {activeLiveSessionId && !isBroadcastingLive && liveConnectionState === 'connected' && userLocation && (
                        <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
                          <div className="flex items-center gap-1 text-cyan-600">
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span className="text-[11px] font-bold uppercase tracking-wider">
                              {Math.round(haversineDistanceMeters(userLocation, sharedIntent.coordinates))}m away
                            </span>
                          </div>
                        </div>
                      )}
                      
                      {!activeLiveSessionId && (
                        <p className="text-xs font-medium text-slate-500">Shared location marker active</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {activeLiveSessionId && isBroadcastingLive && (
                    <button
                      onClick={handleReshareLiveLocation}
                      className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-600 text-white shadow-md transition hover:bg-rose-700 active:scale-90"
                      title="Share link"
                    >
                      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M7.21 14.77l9.52 5.52M16.73 3.71l-9.52 5.52M21 19a3 3 0 11-6 0 3 3 0 016 0zM9 12a3 3 0 11-6 0 3 3 0 016 0zM21 5a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                  
                  <button 
                    onClick={() => {
                      if (isBroadcastingLive) handleStopBroadcast();
                      else if (activeLiveSessionId) handleLeaveSession();
                      else setSharedIntent(null);
                    }}
                    className={`flex h-10 w-10 items-center justify-center rounded-xl shadow-sm transition active:scale-90 ${
                      activeLiveSessionId
                        ? 'border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
                        : 'bg-slate-900 text-white hover:bg-slate-800'
                    }`}
                    title={isBroadcastingLive ? 'Stop sharing' : 'Close'}
                  >
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {mobileMenuOpen && (
            <>
              <motion.button
                type="button"
                aria-label="Close map menu"
                className="pointer-events-auto fixed inset-0 z-40 bg-slate-900/28 lg:hidden"
                onClick={handleCloseMobileMenu}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: MOBILE_MENU_EASE }}
              />

              <motion.section
                className="pointer-events-auto fixed inset-y-0 left-0 z-50 flex w-[min(360px,calc(100vw-18px))] transform-gpu flex-col overflow-hidden border-r border-slate-200 bg-white shadow-[0_28px_60px_rgba(15,23,42,0.22)] lg:hidden"
                style={{ willChange: 'transform' }}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.26, ease: MOBILE_MENU_EASE }}
              >
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Campus map</p>
                      <h2 className="mt-1 font-['Outfit'] text-2xl font-semibold text-slate-900">
                        {railView === null
                          ? 'Menu'
                          : railView === 'live'
                            ? 'Live sharing'
                          : railView === 'favourite'
                            ? 'Favourite places'
                            : railView === 'recent'
                              ? 'Recent places'
                              : 'Missed alerts'}
                      </h2>
                    </div>
                    <div className="flex items-center gap-2">
                      {railView !== null && (
                        <button
                          type="button"
                          onClick={() => setRailView(null)}
                          className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600"
                        >
                          Back
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleCloseMobileMenu}
                        className="panel-close-icon"
                        aria-label="Close map menu"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                          <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                    {railView === null ? (
                      <div className="space-y-5">
                        {selectedLocation && (
                          <div className="rounded-3xl border border-cyan-200 bg-cyan-50/70 px-4 py-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">Selected location</p>
                            <p className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-900">{selectedLocation.name}</p>
                            <p className="text-sm font-medium text-slate-600">{selectedLocation.type}</p>
                          </div>
                        )}

                        <div>
                          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Live sharing</p>
                          <div className="space-y-2">
                            {mobileLiveSessionVisible && (
                              <button
                                type="button"
                                onClick={() => {
                                  setMobileMenuOpen(false);
                                  if (isBroadcastingLive) {
                                    void handleReshareLiveLocation();
                                    return;
                                  }

                                  handleLeaveSession();
                                }}
                                className="flex w-full items-center justify-between gap-3 rounded-3xl border border-rose-200 bg-[linear-gradient(135deg,rgba(255,241,242,0.96),rgba(255,255,255,0.98))] px-4 py-4 text-left shadow-[0_14px_32px_rgba(244,63,94,0.08)] transition hover:border-rose-300 hover:shadow-[0_18px_36px_rgba(244,63,94,0.12)]"
                              >
                                <span className="flex min-w-0 items-center gap-3">
                                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-500 text-white shadow-[0_12px_24px_rgba(244,63,94,0.28)]">
                                    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                                      <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block truncate font-semibold text-slate-900">{liveSessionTitle}</span>
                                    <span className="mt-1 block text-sm text-slate-600">{isBroadcastingLive ? 'Share the live link again' : 'Leave the current live session'}</span>
                                  </span>
                                </span>
                                <span className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${liveSessionStatusTone}`}>
                                  {liveSessionStatusLabel}
                                </span>
                              </button>
                            )}

                            {!mobileLiveSessionVisible && (
                              <button
                                type="button"
                                onClick={() => {
                                  setMobileMenuOpen(false);
                                  void handleShareSOS();
                                }}
                                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-rose-300 hover:bg-rose-50/40"
                              >
                                <span>
                                  <span className="block font-semibold text-slate-900">Share live location</span>
                                  <span className="mt-1 block text-sm text-slate-500">Create a protected live link in one tap</span>
                                </span>
                                <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" aria-hidden="true">
                                  <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>

                        <div>
                          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Quick actions</p>
                          <div className="space-y-2">
                            <button
                              type="button"
                              onClick={handleCampusRail}
                              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-cyan-300 hover:bg-cyan-50/40"
                            >
                              <span>
                                <span className="block font-semibold text-slate-900">Campus overview</span>
                                <span className="mt-1 block text-sm text-slate-500">Recenter the map and clear filters</span>
                              </span>
                              <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" aria-hidden="true">
                                <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>

                            <button
                              type="button"
                              onClick={handleOpenMobileLocationDetails}
                              disabled={!selectedLocation}
                              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-cyan-300 hover:bg-cyan-50/40 disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              <span>
                                <span className="block font-semibold text-slate-900">Location details</span>
                                <span className="mt-1 block text-sm text-slate-500">
                                  {selectedLocation ? 'Open the selected place card' : 'Select a place on the map first'}
                                </span>
                              </span>
                              <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" aria-hidden="true">
                                <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          </div>
                        </div>

                        <div>
                          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Your places</p>
                          <div className="space-y-2">
                            <button
                              type="button"
                              onClick={() => handleOpenMobileMenuView('favourite')}
                              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-cyan-300 hover:bg-cyan-50/40"
                            >
                              <span>
                                <span className="block font-semibold text-slate-900">Favourite places</span>
                                <span className="mt-1 block text-sm text-slate-500">{favouriteLocations.length} saved place{favouriteLocations.length === 1 ? '' : 's'}</span>
                              </span>
                              <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" aria-hidden="true">
                                <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleOpenMobileMenuView('recent')}
                              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-cyan-300 hover:bg-cyan-50/40"
                            >
                              <span>
                                <span className="block font-semibold text-slate-900">Recent places</span>
                                <span className="mt-1 block text-sm text-slate-500">{recentLocations.length} recently opened</span>
                              </span>
                              <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" aria-hidden="true">
                                <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleOpenMobileMenuView('alerts')}
                              className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                                hasUnreadAlerts
                                  ? 'border-cyan-300 bg-cyan-50/70 hover:border-cyan-400'
                                  : 'border-slate-200 bg-white hover:border-cyan-300 hover:bg-cyan-50/40'
                              }`}
                            >
                              <span>
                                <span className="block font-semibold text-slate-900">Missed alerts</span>
                                <span className="mt-1 block text-sm text-slate-500">
                                  {unreadNotificationCount > 0 ? `${unreadNotificationCount} unread update${unreadNotificationCount === 1 ? '' : 's'}` : 'No unread alerts right now'}
                                </span>
                              </span>
                              <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" aria-hidden="true">
                                <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : railView === 'live' ? (
                      <div className="space-y-4">
                        <div className="rounded-3xl border border-rose-200 bg-[linear-gradient(145deg,rgba(255,241,242,0.98),rgba(255,255,255,0.98))] px-4 py-4 shadow-[0_16px_34px_rgba(244,63,94,0.08)]">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-600">Live sharing</p>
                              <h3 className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-900">{liveMenuTitle}</h3>
                              <p className="mt-2 text-sm text-slate-600">{liveMenuDescription}</p>
                            </div>
                            <span className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${liveSessionStatusTone}`}>
                              {liveSessionStatusLabel}
                            </span>
                          </div>
                        </div>

                        {mobileLiveSessionVisible ? (
                          <div className="space-y-3">
                            <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-['Outfit'] text-xl font-semibold text-slate-900">{liveSessionTitle}</p>
                                  <p className="mt-1 text-sm text-slate-500">
                                    {isBroadcastingLive
                                      ? 'Your audience sees updates only after the verified live session is connected.'
                                      : 'This panel keeps viewer state, reconnect status, and leave controls together.'}
                                  </p>
                                </div>
                                <span className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${liveSessionStatusTone}`}>
                                  {liveSessionStatusLabel}
                                </span>
                              </div>

                              <div className="mt-4 grid grid-cols-2 gap-3">
                                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Viewers</p>
                                  <p className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-900">{isBroadcastingLive ? liveViewerCount : '--'}</p>
                                </div>
                                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Signal</p>
                                  <p className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-900">
                                    {liveConnectionState === 'connected'
                                      ? liveGpsAccuracy !== null
                                        ? liveGpsAccuracy < 15
                                          ? 'Strong'
                                          : liveGpsAccuracy < 40
                                            ? 'Fair'
                                            : 'Weak'
                                        : 'Live'
                                      : liveConnectionState === 'offline'
                                        ? 'Offline'
                                        : liveConnectionState === 'rejected'
                                          ? 'Rejected'
                                          : 'Syncing'}
                                  </p>
                                </div>
                              </div>
                            </div>

                            <div className="space-y-2">
                              {isBroadcastingLive && (
                                <button
                                  type="button"
                                  onClick={() => void handleReshareLiveLocation()}
                                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-left text-rose-700 transition hover:border-rose-300 hover:bg-rose-100/70"
                                >
                                  <span>
                                    <span className="block font-semibold">Share live link</span>
                                    <span className="mt-1 block text-sm text-rose-600">Send an updated protected link to viewers.</span>
                                  </span>
                                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M7.21 14.77l9.52 5.52M16.73 3.71l-9.52 5.52M21 19a3 3 0 11-6 0 3 3 0 016 0zM9 12a3 3 0 11-6 0 3 3 0 016 0zM21 5a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              )}

                              {!isBroadcastingLive && (
                                <button
                                  type="button"
                                  onClick={handleLeaveSession}
                                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-left text-rose-700 transition hover:border-rose-300 hover:bg-rose-100/70"
                                >
                                  <span>
                                    <span className="block font-semibold">Leave live session</span>
                                    <span className="mt-1 block text-sm text-rose-600">Close this viewer session and return to the regular map.</span>
                                  </span>
                                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={isBroadcastingLive ? handleStopBroadcast : handleLeaveSession}
                                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-rose-300 hover:bg-rose-50/40"
                              >
                                <span>
                                  <span className="block font-semibold text-slate-900">{isBroadcastingLive ? 'Stop live sharing' : 'Close live panel'}</span>
                                  <span className="mt-1 block text-sm text-slate-500">
                                    {isBroadcastingLive ? 'End the current live session for everyone.' : 'Leave the verified live session and clear the panel.'}
                                  </span>
                                </span>
                                <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.9">
                                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
                              <p className="font-['Outfit'] text-xl font-semibold text-slate-900">Start a live session</p>
                              <p className="mt-2 text-sm text-slate-600">
                                Create a protected live link that viewers can open without exposing raw coordinates in the URL.
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={handleShareSOS}
                              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-left text-rose-700 transition hover:border-rose-300 hover:bg-rose-100/70"
                            >
                              <span>
                                <span className="block font-semibold">Start live sharing</span>
                                <span className="mt-1 block text-sm text-rose-600">Generate a protected link and begin sharing your path.</span>
                              </span>
                              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9">
                                <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                    ) : railView === 'alerts' ? (
                      visibleNotificationEvents.length === 0 ? (
                        <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                          No missed alerts yet. Favourite a location to start tracking live changes.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {visibleNotificationEvents.map((event) => {
                            const isUnread = event.createdAt > notificationFeedSeenAt;

                            return (
                              <button
                                key={event.id}
                                type="button"
                                onClick={() => openRailNotification(event)}
                                className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                                  isUnread
                                    ? 'border-cyan-200 bg-cyan-50/60 hover:border-cyan-300'
                                    : 'border-slate-200 bg-white hover:border-cyan-200 hover:bg-cyan-50/30'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="font-['Outfit'] text-lg font-semibold text-slate-900">{event.locationName}</p>
                                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                                      {event.module} - {formatRelativeTime(event.createdAt)}
                                    </p>
                                  </div>
                                  {isUnread && (
                                    <span className="rounded-full bg-cyan-600 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
                                      New
                                    </span>
                                  )}
                                </div>
                                <p className="mt-2 text-sm font-medium text-slate-700">{event.body}</p>
                              </button>
                            );
                          })}
                        </div>
                      )
                    ) : railItems.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                        {railView === 'favourite'
                          ? 'No favourite places yet. Open a location and tap Favourite in details.'
                          : 'No recent places yet. Search or tap a location on the map.'}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {railView === 'recent' && recentLocations.length > 0 && (
                          <button
                            type="button"
                            onClick={clearRecentLocations}
                            className="mb-2 rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                          >
                            Clear recent
                          </button>
                        )}

                        {visibleRailItems.map((location) => (
                          <div
                            key={`${railView}_${location.id}`}
                            className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 transition hover:border-cyan-300 hover:bg-cyan-50/40"
                          >
                            <button
                              type="button"
                              onClick={() => openRailLocation(location)}
                              className="flex-1 text-left"
                            >
                              <p className="font-['Outfit'] text-lg font-semibold text-slate-900">{location.name}</p>
                              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                {location.type} - {formatRelativeTime(location.timestamp)}
                              </p>
                            </button>

                            {railView === 'favourite' && (
                              <button
                                type="button"
                                onClick={() => removeFavouriteLocation(location.id)}
                                className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </motion.section>
            </>
          )}
        </AnimatePresence>

        <aside
          className={`gm-rail-shell pointer-events-auto absolute left-0 top-0 bottom-0 z-30 hidden lg:flex lg:flex-col ${
            railExpanded ? '' : 'gm-rail-shell-collapsed'
          }`}
        >
          <button
            type="button"
            className="gm-rail-top-toggle"
            onClick={handleToggleRailExpanded}
            aria-expanded={railExpanded}
            aria-label={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
            title={railExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <svg className="gm-rail-glyph" viewBox="0 0 24 24" aria-hidden="true">
              {railExpanded ? (
                <path
                  d="M6 6l12 12M18 6 6 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M5 7.5h14M5 12h14M5 16.5h14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
            <span className="sr-only">{railExpanded ? 'Collapse sidebar' : 'Expand sidebar'}</span>
          </button>

          <div className="gm-rail-nav">
            {/* menu title removed intentionally */}

            <button
              type="button"
              className={`gm-rail-item ${railView === 'favourite' ? 'gm-rail-item-primary' : ''}`}
              title="Favourite places"
              onClick={() => handleToggleRailView('favourite')}
            >
              <svg className="gm-rail-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
              {railExpanded && <span className="gm-rail-label">Favourite</span>}
            </button>

            <button
              type="button"
              className={`gm-rail-item ${railView === 'recent' ? 'gm-rail-item-primary' : ''}`}
              title="Recent places"
              onClick={() => handleToggleRailView('recent')}
            >
              <svg className="gm-rail-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {railExpanded && <span className="gm-rail-label">Recent</span>}
            </button>

            <button
              type="button"
              className={`gm-rail-item ${railView === 'alerts' ? 'gm-rail-item-primary' : ''} ${
                hasUnreadAlerts && railView !== 'alerts' ? 'gm-rail-item-attention' : ''
              }`}
              title="Missed alerts"
              onClick={() => handleToggleRailView('alerts')}
            >
              <svg className="gm-rail-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 4a4 4 0 0 0-4 4v1.1c0 .7-.2 1.3-.6 1.9L6 13.2V15h12v-1.8l-1.4-2.2a3.7 3.7 0 0 1-.6-1.9V8a4 4 0 0 0-4-4Zm0 16a2.5 2.5 0 0 0 2.3-1.5h-4.6A2.5 2.5 0 0 0 12 20Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {railExpanded && (
                <span className="flex items-center gap-2">
                  <span className="gm-rail-label">Alerts</span>
                  {hasUnreadAlerts && (
                    <span className="alert-attention-pill" aria-label={`${unreadNotificationCount} unread alerts`}>
                      <span className="alert-attention-dot" aria-hidden="true" />
                      {Math.min(unreadNotificationCount, 9)}+
                    </span>
                  )}
                </span>
              )}
              {!railExpanded && hasUnreadAlerts && (
                <span className="alert-rail-corner-badge" aria-label={`${unreadNotificationCount} unread alerts`}>
                  {Math.min(unreadNotificationCount, 9)}
                </span>
              )}
            </button>

            <button
              type="button"
              className="gm-rail-item"
              title="Campus"
              onClick={handleCampusRail}
            >
              <svg className="gm-rail-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9 12 5l8 4-8 4-8-4Zm3 1.5v4.3c0 .9 2.2 2.2 5 2.2s5-1.3 5-2.2v-4.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {railExpanded && <span className="gm-rail-label">Campus</span>}
            </button>
            <button
              type="button"
              className="gm-rail-item text-rose-600 hover:bg-rose-50"
              title="Share Live Location"
              onClick={handleShareSOS}
            >
              <svg className="gm-rail-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {railExpanded && <span className="gm-rail-label font-bold text-rose-700">Live</span>}
            </button>
          </div>


        </aside>

        {showRailListPanel && (
          <section
            className={`pointer-events-auto absolute top-3 hidden max-h-[calc(100vh-24px)] w-[330px] overflow-y-auto rounded-3xl border border-white/75 bg-white/95 p-4 shadow-[0_24px_56px_rgba(15,23,42,0.22)] backdrop-blur lg:block ${
              railExpanded ? 'left-[188px]' : 'left-[94px]'
            }`}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-['Outfit'] text-2xl font-semibold text-slate-900">
                {railView === 'favourite'
                  ? 'Favourite places'
                  : railView === 'recent'
                    ? 'Recent places'
                    : 'Missed alerts'}
              </h3>
              <div className="flex items-center gap-2">
                {railView === 'recent' && recentLocations.length > 0 && (
                  <button
                    type="button"
                    onClick={clearRecentLocations}
                    className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setRailView(null)}
                  className="panel-close-icon"
                  aria-label="Close panel"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                    <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {railView === 'alerts' ? (
              visibleNotificationEvents.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                  No missed alerts yet. Favourite a location to start tracking live changes.
                </p>
              ) : (
                <div className="space-y-2">
                  {visibleNotificationEvents.map((event) => {
                    const isUnread = event.createdAt > notificationFeedSeenAt;

                    return (
                      <button
                        key={event.id}
                        type="button"
                        onClick={() => openRailNotification(event)}
                        className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                          isUnread
                            ? 'border-cyan-200 bg-cyan-50/60 hover:border-cyan-300'
                            : 'border-slate-200 bg-white hover:border-cyan-200 hover:bg-cyan-50/30'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-['Outfit'] text-lg font-semibold text-slate-900">
                              {event.locationName}
                            </p>
                            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                              {event.module} • {formatRelativeTime(event.createdAt)}
                            </p>
                          </div>
                          {isUnread && (
                            <span className="rounded-full bg-cyan-600 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
                              New
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-sm font-medium text-slate-700">{event.body}</p>
                      </button>
                    );
                  })}
                </div>
              )
            ) : railItems.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                {railView === 'favourite'
                  ? 'No favourite places yet. Open a location and tap Favourite in details.'
                  : 'No recent places yet. Search or tap a location on the map.'}
              </p>
            ) : (
              <div className="space-y-2">
                {visibleRailItems.map((location) => (
                  <div
                    key={`${railView}_${location.id}`}
                    className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 transition hover:border-cyan-300 hover:bg-cyan-50/40"
                  >
                    <button
                      type="button"
                      onClick={() => openRailLocation(location)}
                      className="flex-1 text-left"
                    >
                      <p className="font-['Outfit'] text-lg font-semibold text-slate-900">{location.name}</p>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {location.type} - {formatRelativeTime(location.timestamp)}
                      </p>
                    </button>

                    {railView === 'favourite' && (
                      <button
                        type="button"
                        onClick={() => removeFavouriteLocation(location.id)}
                        className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {clientConfig.features.search && (
          <div
            className={`gm-search-shell pointer-events-auto absolute left-3 right-3 top-3 sm:left-4 sm:right-auto lg:top-4 ${
              railExpanded ? 'lg:left-[188px]' : 'lg:left-[94px]'
            }`}
          >
            <SearchBar
              geojsonData={geojsonData}
              disabled={locationsState !== 'ready'}
              placeholder="Where do you want to go?"
              leadingSlot={(
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleToggleMobileMenu();
                    }}
                    className="grid h-10 w-10 place-items-center rounded-full text-cyan-700 transition hover:bg-cyan-50 lg:hidden"
                    aria-label="Open map menu"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                      <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                    </svg>
                  </button>
                  <span className="pointer-events-none hidden h-9 w-9 place-items-center rounded-full bg-white text-cyan-700 lg:grid">
                    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden="true">
                      <path d="m21 21-4.3-4.3M10.7 18a7.3 7.3 0 1 0 0-14.6 7.3 7.3 0 0 0 0 14.6Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </div>
              )}
              onResultSelect={(result) => {
                setActiveCampusPanel(null);
                openLocation(result.location, true, true);
              }}
              onActiveChange={handleSearchActiveChange}
            />
          </div>
        )}

        {quickFilterVisible && (
          <div
            className={`pointer-events-none absolute left-3 right-3 top-[5rem] z-30 sm:left-4 lg:top-[1.35rem] ${
              railExpanded ? 'lg:left-[calc(188px+min(620px,calc(100vw-132px))+16px)]' : 'lg:left-[calc(94px+min(620px,calc(100vw-132px))+16px)]'
            } lg:right-24`}
          >
            <div
              className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveFilters([]);
                  setShowPowerSupplyOverlay(false);
                }}
                className={quickFilterButtonClass(activeFilters.length === 0 && !showPowerSupplyOverlay)}
              >
                All
              </button>

              {visibleCategoryRail.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => toggleFilter(category)}
                  className={quickFilterButtonClass(activeFilters.includes(category))}
                >
                  {displayFilterName(category)}
                </button>
              ))}

              {clientConfig.features.powerStatus && (
                <button
                  type="button"
                  onClick={() => setShowPowerSupplyOverlay((value) => !value)}
                  className={quickFilterButtonClass(showPowerSupplyOverlay)}
                  aria-label={`${showPowerSupplyOverlay ? 'Hide' : 'Show'} locations with power availability`}
                >
                  Power
                </button>
              )}

              <button
                type="button"
                onClick={() => setCategoryRailExpanded((value) => !value)}
                className={quickFilterButtonClass(categoryRailExpanded)}
              >
                {categoryRailExpanded ? 'Less' : hasMoreCategories ? 'More' : 'More filters'}
              </button>

            </div>
          </div>
        )}

        {!locationDetailsOpen && (
          <button
            type="button"
            onClick={() => openCampusPanel('layers')}
            className={`pointer-events-auto absolute right-[var(--mobile-open-layers-right)] bottom-[var(--mobile-open-layers-bottom)] z-30 inline-flex items-center gap-2 rounded-full border border-white/80 px-3.5 py-2 text-xs font-semibold uppercase tracking-wide shadow-[0_14px_32px_rgba(15,23,42,0.2)] transition md:bottom-auto md:right-4 md:top-24 lg:right-5 ${
              activeCampusPanel === 'layers'
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-700 hover:border-slate-300 hover:text-slate-950'
            }`}
            style={{
              ['--mobile-open-layers-bottom' as '--mobile-open-layers-bottom']: `${mobileOpenLayersBottomPx}px`,
              ['--mobile-open-layers-right' as '--mobile-open-layers-right']: `${mobileOpenLayersRightPx}px`,
            } as CSSProperties}
            aria-label="Map layers"
            title="Map layers"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path d="m12 3 8 4-8 4-8-4 8-4Zm8 8-8 4-8-4m16 4-8 4-8-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Map layers</span>
          </button>
        )}

        {shouldShowCampusPanel && (
          <section
            className="directory-panel-shell bottom-sheet-enter mobile-bottom-dock pointer-events-auto absolute inset-x-3 z-40 flex max-h-[58vh] flex-col overflow-hidden rounded-3xl border border-white/70 bg-white shadow-[0_24px_56px_rgba(15,23,42,0.26)] md:inset-x-auto md:right-4 md:top-24 md:bottom-auto md:w-[390px] md:max-h-[68vh] lg:right-5 lg:w-[430px] lg:max-h-[72vh]"
          >
            <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-slate-200 md:hidden" />
            <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Campus map</p>
                <h2 className="mt-1 font-['Outfit'] text-2xl font-semibold text-slate-900">
                  {activeCampusPanel === 'directory'
                    ? userLocation ? 'Nearby places' : 'Campus directory'
                    : 'Map layers'}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveCampusPanel(null)}
                  className="panel-close-icon"
                  aria-label="Close panel"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                    <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">
              {activeCampusPanel === 'directory' && (
                <>
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <p className="text-sm font-medium text-slate-600">
                      {userLocation ? 'Closest matching places based on your current location.' : 'Start with common campus locations, then refine with search or filters.'}
                    </p>
                    <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {visibleBuildings.length} shown
                    </p>
                  </div>

                  {visibleBuildings.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                      No places match these filters.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {directoryBuildings.map((building) => (
                        <button
                          key={building.id}
                          type="button"
                          onClick={() => handleBuildingClick(building)}
                          className="wia-directory-card"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                                {displayFilterName(building.type)}
                              </span>
                              <h4 className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-900">
                                {building.name}
                              </h4>
                            </div>
                            <span className="text-xs font-semibold uppercase tracking-wide text-cyan-700">Open</span>
                          </div>

                          {building.features.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {building.features.slice(0, 3).map((feature, index) => (
                                <span
                                  key={`${building.id}_${feature}_${index}`}
                                  className="rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-medium text-cyan-700"
                                >
                                  {feature}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeCampusPanel === 'layers' && (
                <div className="space-y-4">
                  <WeatherLayerCard
                    enabled={activeCampusPanel === 'layers'}
                    userLocation={userLocation}
                    gpsStatus={gpsDiagnostics.status}
                    onRequestLocation={requestGpsAccess}
                  />

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Map view</p>
                    <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1">
                      <button
                        type="button"
                        onClick={() => handleChangeMapViewMode('flat')}
                        disabled={pendingMapViewMode !== null}
                        className={`rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
                          mapViewMode === 'flat' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
                        } disabled:cursor-wait disabled:opacity-70`}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {pendingMapViewMode === 'flat' && (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
                          )}
                          Standard
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleChangeMapViewMode('2_5d')}
                        disabled={!enhancedViewAvailable || pendingMapViewMode !== null}
                        className={`rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
                          mapViewMode === '2_5d' ? 'bg-cyan-600 text-white' : 'text-slate-600 hover:text-slate-900'
                        } disabled:cursor-not-allowed disabled:opacity-45`}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {pendingMapViewMode === '2_5d' && (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
                          )}
                          Enhanced
                        </span>
                      </button>
                    </div>
                    {!enhancedViewAvailable ? (
                      <p className="mt-2 text-xs font-medium text-slate-500">
                        Enhanced view is reduced on this device to keep the map responsive.
                      </p>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Overlays</p>
                    <div className="mt-3 space-y-2">
                      {clientConfig.features.powerStatus && (
                        <button
                          type="button"
                          onClick={() => setShowPowerSupplyOverlay((value) => !value)}
                          className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-cyan-200"
                        >
                          <span>
                            <span className="block font-semibold text-slate-900">Power availability</span>
                            <span className="mt-1 block text-xs text-slate-500">Highlight places with reported power.</span>
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${showPowerSupplyOverlay ? 'bg-cyan-600 text-white' : 'bg-white text-slate-600'}`}>
                            {showPowerSupplyOverlay ? 'Shown' : 'Hidden'}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setShowFellowships((value) => !value)}
                        className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-cyan-200"
                      >
                        <span>
                          <span className="block font-semibold text-slate-900">Fellowships</span>
                          <span className="mt-1 block text-xs text-slate-500">Show schedules and room badges on host venues.</span>
                        </span>
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${showFellowships ? 'bg-cyan-600 text-white' : 'bg-white text-slate-600'}`}>
                          {showFellowships ? 'Shown' : 'Hidden'}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Map details</p>
                    <p className="mt-2 text-sm font-medium text-slate-600">
                      Building outlines and campus labels stay visible so the map remains easy to scan.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
        {/* Live Location Preparing Status Bar */}
        {isSosPreparing && (
          <div className="pointer-events-auto fixed top-0 left-0 right-0 z-[100] flex items-center justify-between bg-rose-600 px-4 py-3 shadow-lg animate-in slide-in-from-top duration-300">
            <div className="flex items-center gap-3">
              <div className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-white"></span>
              </div>
              <p className="font-['Outfit'] text-sm font-bold text-white tracking-wide uppercase">
                Activating Live Location...
              </p>
            </div>
            <button 
              onClick={() => setSosPreparing(false)}
              className="rounded-full bg-white/20 px-3 py-1 text-[10px] font-bold uppercase text-white hover:bg-white/30 transition"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </main>
  );
};

export default HomePage;
