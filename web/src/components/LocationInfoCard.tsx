import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import FellowshipBrandBadge from './FellowshipBrandBadge';
import type { LoadState } from '../core/loadState';
import type { RouteStep } from '../store/useAppStore';
import { useAppStore } from '../store/useAppStore';
import { clientConfig } from '../config/client';
import { getGpsGuidance } from '../core/gpsStatus';
import { resolveFeatureAnchorCoordinates, resolveFeatureId } from '../core/geoGeometry';
import {
  formatFellowshipSchedule,
  normalizeFellowshipCode,
  readFellowshipEntries,
  serviceKey,
} from '../core/fellowshipUtils';
import { useToast } from '../context/ToastContext';
import { ConfirmationModal } from './admin/AdminOpsComponents';
import { requestFavouriteAlertOptIn } from '../services/locationAlerts';
import { reportLocationPowerStatus } from '../services/powerStatus';
import { formatCompactDateTime } from '../utils/dateTime';
import type { MapEngineAdapter } from '../core/mapEngineTypes';

const formatMeters = (distance: number): string => {
  if (distance >= 1000) {
    return `${(distance / 1000).toFixed(1)} km`;
  }

  return `${Math.max(0, Math.round(distance))} m`;
};

const formatEtaMinutes = (minutes: number): string => {
  const totalMinutes = Math.max(0, Math.round(minutes));

  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${remainingMinutes} min`;
};

const CAR_METERS_PER_MINUTE = 250;
const MOTORCYCLE_METERS_PER_MINUTE = 320;
const EARTH_RADIUS_M = 6371000;
const ROUTE_LANDMARK_MAX_LATERAL_M = 34;
const ROUTE_LANDMARK_MAX_AHEAD_M = 120;
const ROUTE_LANDMARK_MIN_AHEAD_M = 10;
type CardPowerAction = 'turn_on' | 'turn_off';

type CampusFeatureCollection = FeatureCollection<Geometry, Record<string, unknown>>;
type ManeuverKind = 'straight' | 'right' | 'left' | 'sharp-right' | 'sharp-left' | 'uturn' | 'continue';

interface RouteStepDisplay {
  step: RouteStep;
  instruction: string;
  distanceLabel: string;
  maneuver: ManeuverKind;
  hint: string | null;
  focusLocation: [number, number];
}

interface RouteSegmentProjection {
  point: [number, number];
  t: number;
  distanceM: number;
}

interface RouteLandmarkCandidate {
  name: string;
  side: 'left' | 'right';
  alongDistanceM: number;
  lateralDistanceM: number;
}

const isRestrictedLocationStatus = (value: unknown): boolean => {
  return typeof value === 'string' && value.trim().toLowerCase() === 'restricted';
};

const readPowerUpdateLocked = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }

  return false;
};

const estimateModeEtaMinutes = (distanceMeters: number, metersPerMinute: number): number => {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(distanceMeters / metersPerMinute));
};

const readFeatureChipValues = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return readFeatureChipValues(parsed);
        }
      } catch {
        // Fall through to delimiter parsing for malformed array-like strings.
      }
    }

    return trimmed
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']+|["']+$/g, '').trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

const formatFeatureChipLabel = (value: string): string => {
  return value
    .split(/\s+/)
    .map((word) => {
      if (!word) {
        return word;
      }

      const letters = word.replace(/[^A-Za-z]/g, '');
      if (letters.length > 1 && letters === letters.toUpperCase()) {
        return word;
      }

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const haversineMeters = (from: [number, number], to: [number, number]): number => {
  const deltaLat = toRadians(to[0] - from[0]);
  const deltaLng = toRadians(to[1] - from[1]);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(toRadians(from[0])) *
      Math.cos(toRadians(to[0])) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const projectToSegment = (
  point: [number, number],
  segmentStart: [number, number],
  segmentEnd: [number, number]
): RouteSegmentProjection => {
  const referenceLat = (point[0] + segmentStart[0] + segmentEnd[0]) / 3;
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));

  const ax = segmentStart[1] * lngFactor;
  const ay = segmentStart[0] * latFactor;
  const bx = segmentEnd[1] * lngFactor;
  const by = segmentEnd[0] * latFactor;
  const px = point[1] * lngFactor;
  const py = point[0] * latFactor;
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const rawT = lengthSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lengthSq : 0;
  const t = Math.max(0, Math.min(1, rawT));
  const projX = ax + abx * t;
  const projY = ay + aby * t;

  return {
    point: [projY / latFactor, projX / lngFactor],
    t,
    distanceM: Math.hypot(px - projX, py - projY),
  };
};

const resolveManeuverKind = (instruction: string): ManeuverKind => {
  const normalized = instruction.trim().toLowerCase();
  if (normalized.startsWith('make a u-turn')) {
    return 'uturn';
  }
  if (normalized.startsWith('make a sharp right')) {
    return 'sharp-right';
  }
  if (normalized.startsWith('make a sharp left')) {
    return 'sharp-left';
  }
  if (normalized.startsWith('turn right')) {
    return 'right';
  }
  if (normalized.startsWith('turn left')) {
    return 'left';
  }
  if (normalized.startsWith('bear right')) {
    return 'right';
  }
  if (normalized.startsWith('bear left')) {
    return 'left';
  }
  if (normalized.startsWith('continue')) {
    return 'continue';
  }
  return 'straight';
};

const cleanRouteInstruction = (instruction: string): string => {
  return instruction
    .replace(/\s+and continue for\s+\d+(?:\.\d+)?\s*(?:m|km)$/i, '')
    .replace(/\s+for\s+\d+(?:\.\d+)?\s*(?:m|km)$/i, '')
    .trim();
};

const sideOfRoute = (
  routeStart: [number, number],
  routeEnd: [number, number],
  point: [number, number]
): 'left' | 'right' => {
  const referenceLat = (routeStart[0] + routeEnd[0] + point[0]) / 3;
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));
  const routeX = (routeEnd[1] - routeStart[1]) * lngFactor;
  const routeY = (routeEnd[0] - routeStart[0]) * latFactor;
  const pointX = (point[1] - routeStart[1]) * lngFactor;
  const pointY = (point[0] - routeStart[0]) * latFactor;
  const cross = routeX * pointY - routeY * pointX;

  return cross >= 0 ? 'left' : 'right';
};

const bearingBetweenPoints = (from: [number, number], to: [number, number]): number => {
  const phi1 = toRadians(from[0]);
  const phi2 = toRadians(to[0]);
  const deltaLambda = toRadians(to[1] - from[1]);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
};

const routePathBearing = (path: [number, number][], fallback: number | null = null): number | null => {
  if (path.length < 2) {
    return fallback;
  }

  for (let index = path.length - 1; index > 0; index -= 1) {
    if (haversineMeters(path[index - 1], path[index]) > 0.8) {
      return bearingBetweenPoints(path[index - 1], path[index]);
    }
  }

  return fallback;
};

const findRoutePointAtDistance = (path: [number, number][], targetDistanceM: number): [number, number] => {
  if (path.length === 0) {
    return [0, 0];
  }

  let traversedM = 0;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    const segmentM = haversineMeters(start, end);
    if (traversedM + segmentM >= targetDistanceM) {
      const t = segmentM > 0 ? (targetDistanceM - traversedM) / segmentM : 0;
      return [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ];
    }
    traversedM += segmentM;
  }

  return path[path.length - 1];
};

const sliceRoutePathBetweenDistances = (
  path: [number, number][],
  startDistanceM: number,
  endDistanceM: number
): [number, number][] => {
  if (path.length < 2) {
    return path;
  }

  const startPoint = findRoutePointAtDistance(path, startDistanceM);
  const endPoint = findRoutePointAtDistance(path, endDistanceM);
  const sliced: [number, number][] = [startPoint];
  let traversedM = 0;

  for (let index = 1; index < path.length; index += 1) {
    const segmentStart = path[index - 1];
    const segmentEnd = path[index];
    const segmentM = haversineMeters(segmentStart, segmentEnd);
    const segmentStartM = traversedM;
    const segmentEndM = traversedM + segmentM;
    traversedM = segmentEndM;

    if (segmentEndM <= startDistanceM || segmentStartM >= endDistanceM) {
      continue;
    }

    if (segmentEndM < endDistanceM) {
      sliced.push(segmentEnd);
    }
  }

  sliced.push(endPoint);
  return sliced.filter((point, index, list) => {
    if (index === 0) {
      return true;
    }
    return haversineMeters(list[index - 1], point) > 0.4;
  });
};

const findNearestLandmarkForStep = (
  step: RouteStep,
  path: [number, number][],
  geojsonData: CampusFeatureCollection | null | undefined,
  selectedLocationId: string
): RouteLandmarkCandidate | null => {
  if (!geojsonData?.features?.length || path.length < 2) {
    return null;
  }

  const stepStartM = step.start_distance_m ?? 0;
  const stepEndM = step.end_distance_m ?? stepStartM + step.distance_m;
  const stepDistanceM = Math.max(0, stepEndM - stepStartM);
  const maxUsefulAheadM = Math.min(
    ROUTE_LANDMARK_MAX_AHEAD_M,
    Math.max(ROUTE_LANDMARK_MIN_AHEAD_M, stepDistanceM - 4)
  );
  const searchEndM = Math.min(stepEndM, stepStartM + maxUsefulAheadM);

  if (searchEndM - stepStartM < ROUTE_LANDMARK_MIN_AHEAD_M) {
    return null;
  }

  let traversedM = 0;
  let best: RouteLandmarkCandidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let segmentIndex = 1; segmentIndex < path.length; segmentIndex += 1) {
    const segmentStart = path[segmentIndex - 1];
    const segmentEnd = path[segmentIndex];
    const segmentM = haversineMeters(segmentStart, segmentEnd);
    const segmentStartM = traversedM;
    const segmentEndM = traversedM + segmentM;
    traversedM = segmentEndM;

    if (segmentEndM < stepStartM || segmentStartM > searchEndM) {
      continue;
    }

    geojsonData.features.forEach((feature: Feature<Geometry, Record<string, unknown>>, index) => {
      const featureId = resolveFeatureId(feature, index);
      const name = typeof feature.properties?.name === 'string' ? feature.properties.name.trim() : '';
      if (!name || featureId === selectedLocationId) {
        return;
      }

      const geometryType = feature.geometry?.type;
      if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
        return;
      }

      const anchor = resolveFeatureAnchorCoordinates(feature);
      const projection = projectToSegment(anchor, segmentStart, segmentEnd);
      const alongDistanceM = segmentStartM + segmentM * projection.t;
      const distanceAheadM = alongDistanceM - stepStartM;

      if (
        distanceAheadM < ROUTE_LANDMARK_MIN_AHEAD_M ||
        distanceAheadM > maxUsefulAheadM ||
        alongDistanceM > searchEndM ||
        projection.distanceM > ROUTE_LANDMARK_MAX_LATERAL_M
      ) {
        return;
      }

      const score = projection.distanceM + distanceAheadM * 0.3;
      if (!best || score < bestScore) {
        bestScore = score;
        best = {
          name,
          side: sideOfRoute(segmentStart, segmentEnd, anchor),
          alongDistanceM: distanceAheadM,
          lateralDistanceM: projection.distanceM,
        };
      }
    });
  }

  return best;
};

const buildDestinationHint = (
  step: RouteStep,
  path: [number, number][],
  destination: [number, number]
): string | null => {
  if (path.length < 2) {
    return null;
  }

  if (step.distance_m < 6) {
    return null;
  }

  const stepStart = findRoutePointAtDistance(path, step.start_distance_m ?? 0);
  const stepEnd = findRoutePointAtDistance(path, step.end_distance_m ?? step.distance_m);
  return `Destination will be on the ${sideOfRoute(stepStart, stepEnd, destination)}`;
};

const buildRouteStepDisplays = (
  steps: RouteStep[],
  path: [number, number][],
  geojsonData: CampusFeatureCollection | null | undefined,
  selectedLocationId: string,
  destination: [number, number]
): RouteStepDisplay[] => {
  return steps.map((step, index) => {
    const landmark = step.landmark_hint
      ? null
      : findNearestLandmarkForStep(step, path, geojsonData, selectedLocationId);
    const generatedHint = landmark
      ? `${landmark.name} will be on your ${landmark.side} in ${formatMeters(landmark.alongDistanceM)}`
      : index === steps.length - 1
        ? buildDestinationHint(step, path, destination)
        : null;
    const stepStartM = step.start_distance_m ?? 0;
    const stepEndM = step.end_distance_m ?? stepStartM + step.distance_m;
    const focusDistanceM = index === 0
      ? Math.min(stepEndM, stepStartM + Math.max(12, step.distance_m * 0.45))
      : stepStartM;

    return {
      step,
      instruction: cleanRouteInstruction(step.instruction),
      distanceLabel: formatMeters(step.distance_m),
      maneuver: resolveManeuverKind(step.instruction),
      hint: step.landmark_hint ?? generatedHint,
      focusLocation: findRoutePointAtDistance(path, focusDistanceM),
    };
  });
};

const ManeuverIcon: React.FC<{ kind: ManeuverKind }> = ({ kind }) => {
  const path =
    kind === 'right'
      ? 'M5 19v-8a4 4 0 0 1 4-4h8m-4-4 4 4-4 4'
      : kind === 'sharp-right'
        ? 'M6 19v-7a5 5 0 0 1 5-5h7m-5-4 5 4-5 4'
      : kind === 'left'
        ? 'M19 19v-8a4 4 0 0 0-4-4H7m4-4-4 4 4 4'
        : kind === 'sharp-left'
          ? 'M18 19v-7a5 5 0 0 0-5-5H6m5-4-5 4 5 4'
          : kind === 'uturn'
            ? 'M7 7h7a4 4 0 0 1 0 8H8m4-4-4 4 4 4'
        : 'M12 20V4m-6 6 6-6 6 6';

  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

/**
 * Location details panel for selected campus locations.
 */
export const LocationInfoCard: React.FC<{
  routingState?: LoadState;
  geojsonData?: CampusFeatureCollection | null;
  mapInstance?: MapEngineAdapter | null;
}> = ({
  routingState = 'ready',
  geojsonData = null,
  mapInstance = null,
}) => {
  const {
    selectedLocation,
    bottomSheetOpen,
    openBottomSheet,
    closeBottomSheet,
    getPowerSignal,
    updatePowerSignals,
    isOnline,
    favouriteLocations,
    toggleFavouriteLocation,
    isFavouriteLocation,
    userLocation,
    gpsDiagnostics,
    requestGpsAccess,
    routePreview,
    routePreviewActive,
    routePreviewStatus,
    routePreviewError,
    routeStepPreviewOpen,
    setRoutePreviewActive,
    clearRoutePreview,
    followUserLocation,
    setFollowUserLocation,
    routeFocusHighlight,
    setRouteFocusHighlight,
    fellowshipBrandsByCode,
    focusSelectedLocationFellowship,
  } = useAppStore();
  const { showError, showSuccess, showWarning } = useToast();

  const [expandedRouteSteps, setExpandedRouteSteps] = useState(false);
  const [confirmPowerAction, setConfirmPowerAction] = useState<CardPowerAction | null>(null);
  const [confirmRestrictedRoute, setConfirmRestrictedRoute] = useState(false);
  const [powerActionPending, setPowerActionPending] = useState<CardPowerAction | null>(null);
  const fellowshipSectionRef = useRef<HTMLDivElement | null>(null);
  const focusedFellowshipCardRef = useRef<HTMLDivElement | null>(null);
  const selectedLocationId = selectedLocation?.id ?? null;
  const liveTrackingEnabled = clientConfig.features.liveTracking;
  const offlineSupportEnabled = clientConfig.offline.enabled;

  useEffect((): void => {
    setExpandedRouteSteps(false);
  }, [selectedLocationId]);

  useEffect((): void => {
    setConfirmPowerAction(null);
    setConfirmRestrictedRoute(false);
    setPowerActionPending(null);
  }, [selectedLocationId]);

  useEffect(() => {
    if (!liveTrackingEnabled && followUserLocation) {
      setFollowUserLocation(false);
    }
  }, [followUserLocation, liveTrackingEnabled, setFollowUserLocation]);

  const activeRouteWarning =
    routePreviewActive && routePreview?.destination_id === selectedLocationId
      ? routePreview.warning_message
      : null;

  useEffect(() => {
    if (!selectedLocationId || !activeRouteWarning) {
      return;
    }

    /*showWarning(activeRouteWarning, {
      title: 'Navigation note',
      dedupeKey: `route-warning-${selectedLocationId}-${activeRouteWarning}`,
    });*/
  }, [activeRouteWarning, selectedLocationId, showWarning]);

  const locationFeatures = useMemo(() => {
    const selectedFeature = geojsonData?.features?.find(
      (feature, index) => resolveFeatureId(feature, index) === selectedLocationId
    );
    const values = [
      ...readFeatureChipValues(selectedLocation?.properties?.features),
      ...readFeatureChipValues(selectedFeature?.properties?.features),
    ];
    const labelsByNormalizedValue = new Map<string, string>();

    values.forEach((value) => {
      const label = formatFeatureChipLabel(value);
      const normalized = label.toLowerCase();
      if (!labelsByNormalizedValue.has(normalized)) {
        labelsByNormalizedValue.set(normalized, label);
      }
    });

    return [...labelsByNormalizedValue.values()];
  }, [geojsonData, selectedLocation?.properties?.features, selectedLocationId]);

  const focusedFellowshipCode = (selectedLocation?.fellowshipFocusCode ?? '').trim().toUpperCase();
  const focusedServiceKey = selectedLocation?.fellowshipServiceFocusKey ?? '';

  const fellowshipEntries = useMemo(() => {
    const entries = readFellowshipEntries(selectedLocation?.properties?.fellowships);

    return [...entries].sort((left, right) => {
      const leftFocused = left.code === focusedFellowshipCode;
      const rightFocused = right.code === focusedFellowshipCode;

      if (leftFocused === rightFocused) {
        return left.code.localeCompare(right.code);
      }

      return leftFocused ? -1 : 1;
    });
  }, [focusedFellowshipCode, selectedLocation]);

  useEffect(() => {
    if (!bottomSheetOpen || !focusedFellowshipCode || fellowshipEntries.length === 0) {
      return;
    }

    const targetElement = focusedFellowshipCardRef.current ?? fellowshipSectionRef.current;

    if (!targetElement) {
      return;
    }

    let frameId = 0;
    const timeoutId = window.setTimeout(() => {
      frameId = window.requestAnimationFrame(() => {
        targetElement.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
          inline: 'nearest',
        });
      });
    }, 80);

    return () => {
      window.clearTimeout(timeoutId);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [bottomSheetOpen, fellowshipEntries.length, focusedFellowshipCode, focusedServiceKey, selectedLocationId]);

  if (!selectedLocation) {
    return null;
  }

  const powerSignal = getPowerSignal(selectedLocation.id);
  const locationFavourited = isFavouriteLocation(selectedLocation.id);
  const powerUpdateLocked = readPowerUpdateLocked(selectedLocation.properties?.power_update_locked);
  const restrictedLocation = isRestrictedLocationStatus(selectedLocation.properties?.status);

  const lastUpdatedTimestamp =
    powerSignal?.reportedAt ??
    (selectedLocation.properties?.last_updated as number | undefined);

  const occupancyRaw = selectedLocation.properties?.occupancy;
  const occupancy =
    typeof occupancyRaw === 'number' && Number.isFinite(occupancyRaw)
      ? Math.max(0, Math.round(occupancyRaw))
      : null;

  const occupancyBand =
    occupancy === null ? 'Unknown' : occupancy >= 1000 ? 'High' : occupancy >= 350 ? 'Medium' : 'Low';

  const occupancyBadgeStyle =
    occupancyBand === 'High'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : occupancyBand === 'Medium'
        ? 'border-sky-200 bg-sky-50 text-sky-700'
        : occupancyBand === 'Low'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-slate-200 bg-slate-100 text-slate-600';

  const activeRoute =
    routePreviewActive && routePreview?.destination_id === selectedLocation.id
      ? routePreview
      : null;
  const activeRouteTrackingMessage =
    activeRoute?.tracking_status === 'off_route'
      ? activeRoute.tracking_message ?? "You're off the highlighted route. The route will update from your current position."
      : null;
  const isDirectFallbackRoute = activeRoute?.route_kind === 'fallback_direct';
  const activeFallbackReason =
    isDirectFallbackRoute
      ? activeRoute?.fallback_reason ?? activeRoute?.warning_message ?? 'Turn-by-turn guidance is unavailable for this route.'
      : null;
  const activeRouteWarningMessage =
    activeRoute && !isDirectFallbackRoute ? activeRoute.warning_message ?? null : null;

  const isRouteLoading = routePreviewActive && routePreviewStatus === 'preparing';
  const etaToShow = activeRoute ? activeRoute.eta_smoothed_min ?? activeRoute.eta_min : null;
  const distanceToShow = activeRoute ? activeRoute.remaining_distance_m ?? activeRoute.distance_m : null;
  const routeEtaChips = activeRoute
    ? [
      { label: 'Walk', minutes: etaToShow ?? 0 },
      { label: 'Car', minutes: estimateModeEtaMinutes(distanceToShow ?? 0, CAR_METERS_PER_MINUTE) },
      {
        label: 'Motorcycle',
        minutes: estimateModeEtaMinutes(distanceToShow ?? 0, MOTORCYCLE_METERS_PER_MINUTE),
      },
    ]
    : [];

  const progressStepIndex = activeRoute
    ? Math.min(
      Math.max(activeRoute.current_step_index ?? 0, 0),
      Math.max(activeRoute.steps.length - 1, 0)
    )
    : 0;

  const upcomingSteps = useMemo(
    () => (activeRoute ? activeRoute.steps.slice(progressStepIndex) : []),
    [activeRoute, progressStepIndex]
  );

  const visibleRouteSteps = useMemo(
    () => (expandedRouteSteps ? upcomingSteps : upcomingSteps.slice(0, 4)),
    [expandedRouteSteps, upcomingSteps]
  );

  const visibleRouteStepDisplays = useMemo(
    () =>
      activeRoute
        ? buildRouteStepDisplays(
          visibleRouteSteps,
          activeRoute.path,
          geojsonData,
          selectedLocation.id,
          selectedLocation.coordinates
        )
        : [],
    [activeRoute, geojsonData, selectedLocation.coordinates, selectedLocation.id, visibleRouteSteps]
  );

  const handleRouteStepFocus = (display: RouteStepDisplay): void => {
    if (!mapInstance) {
      return;
    }

    setFollowUserLocation(false);
    const stepStartM = display.step.start_distance_m ?? 0;
    const stepEndM = display.step.end_distance_m ?? stepStartM + display.step.distance_m;
    const focusPath = activeRoute
      ? sliceRoutePathBetweenDistances(activeRoute.path, stepStartM, stepEndM)
      : [display.focusLocation];
    const arrowStartM = display.maneuver === 'straight' || display.maneuver === 'continue'
      ? stepStartM
      : Math.max(0, stepStartM - 18);
    const arrowEndM = Math.min(
      stepEndM,
      stepStartM + Math.max(24, Math.min(52, display.step.distance_m))
    );
    const arrowPath = activeRoute
      ? sliceRoutePathBetweenDistances(activeRoute.path, arrowStartM, arrowEndM)
      : focusPath;
    const highlightId = `route_step_${display.step.id}_${Date.now()}`;
    const highlightBearing = routePathBearing(focusPath, null);
    setRouteFocusHighlight({
      id: highlightId,
      path: focusPath.length >= 2 ? focusPath : [display.focusLocation, display.focusLocation],
      arrowPath: arrowPath.length >= 2 ? arrowPath : focusPath,
      point: display.focusLocation,
      label: display.instruction,
      maneuver: display.maneuver,
      bearingDeg: highlightBearing,
      renderDurationMs: 2400,
      expiresAt: Date.now() + 10000,
    });

    window.setTimeout(() => {
      const current = useAppStore.getState().routeFocusHighlight;
      if (current?.id === highlightId) {
        useAppStore.getState().setRouteFocusHighlight(null);
      }
    }, 10100);

    const nextZoom = Math.max(mapInstance.getZoom(), 18);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      closeBottomSheet();
    }
    mapInstance.flyTo(display.focusLocation, nextZoom, { duration: 0.52 });
  };

  const remainingStepCount = Math.max(0, upcomingSteps.length - visibleRouteSteps.length);
  const nextTurnDistanceM = activeRoute?.distance_to_next_turn_m ?? 0;
  const nextTurnLabel = nextTurnDistanceM <= 2 ? 'now' : `in ${formatMeters(nextTurnDistanceM)}`;

  const gpsGuidance = getGpsGuidance(gpsDiagnostics.status, gpsDiagnostics.errorMessage);

  const gpsPanelToneClass =
    gpsGuidance.tone === 'critical'
      ? 'border-rose-200 bg-rose-50 text-rose-800'
      : gpsGuidance.tone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : gpsGuidance.tone === 'positive'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-cyan-200 bg-cyan-50 text-cyan-800';

  const powerBadgeStyle = powerSignal
    ? powerSignal.powerStatus
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-rose-200 bg-rose-50 text-rose-700'
    : 'border-slate-200 bg-slate-50 text-slate-600';

  const powerLabel = powerSignal
    ? powerSignal.powerStatus
      ? 'Available'
      : 'Unavailable'
    : 'No report';
  const powerAlreadyOn = Boolean(powerSignal?.powerStatus);
  const powerAlreadyOff = powerSignal?.powerStatus === false;
  const powerTurnOnDisabled = Boolean(powerActionPending) || powerUpdateLocked || !isOnline || powerAlreadyOn;
  const powerTurnOffDisabled = Boolean(powerActionPending) || powerUpdateLocked || !isOnline || powerAlreadyOff;
  const powerTurnOnLabel =
    powerActionPending === 'turn_on'
      ? 'Turning power on...'
      : powerUpdateLocked
        ? 'Admins only'
      : powerAlreadyOn
        ? 'Power already on'
        : !isOnline
          ? 'Reconnect to turn power on'
          : 'Turn power on';
  const powerTurnOffLabel =
    powerActionPending === 'turn_off'
      ? 'Turning power off...'
      : powerUpdateLocked
        ? 'Admins only'
      : powerAlreadyOff
        ? 'Power already off'
        : !isOnline
          ? 'Reconnect to turn power off'
          : 'Turn power off';
  const powerControlToneClass = powerUpdateLocked
    ? 'border-amber-200 bg-amber-50/70'
    : powerAlreadyOn
      ? 'border-emerald-200 bg-emerald-50/60'
      : powerAlreadyOff
        ? 'border-rose-200 bg-rose-50/60'
        : 'border-slate-200 bg-slate-50';
  const powerStatusChipClass = powerUpdateLocked
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : powerAlreadyOn
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : powerAlreadyOff
        ? 'border-rose-200 bg-rose-50 text-rose-700'
        : 'border-slate-200 bg-white text-slate-600';

  const navigationButtonLabel =
    isRouteLoading
      ? 'Preparing route...'
      : activeRoute
      ? 'Stop route preview'
      : 'Start navigation';
  const navigationButtonBusy =
    isRouteLoading || (!activeRoute && gpsDiagnostics.status === 'checking' && !userLocation);

  const lastUpdated =
    typeof lastUpdatedTimestamp === 'number'
      ? formatCompactDateTime(lastUpdatedTimestamp)
      : null;

  const handleToggleFavourite = (): void => {
    const nextFavouriteIds = locationFavourited
      ? favouriteLocations.filter((location) => location.id !== selectedLocation.id).map((location) => location.id)
      : [selectedLocation.id, ...favouriteLocations.filter((location) => location.id !== selectedLocation.id).map((location) => location.id)].slice(0, 5);

    toggleFavouriteLocation(selectedLocation);
    showSuccess(locationFavourited ? 'Removed from favourites.' : 'Added to favourites.', {
      title: 'Favourites',
      dedupeKey: `favourite-location-${selectedLocation.id}-${locationFavourited ? 'off' : 'on'}`,
    });

    if (locationFavourited) {
      return;
    }

    void requestFavouriteAlertOptIn(nextFavouriteIds)
      .then((result) => {
        if (result.status === 'subscribed') {
          showSuccess('Push alerts are now enabled for your favourites.', {
            title: 'Favourite alerts',
            dedupeKey: 'favourite-alerts-enabled',
          });
          return;
        }

        if (
          result.status === 'unsupported' ||
          result.status === 'blocked' ||
          result.status === 'unavailable'
        ) {
          showWarning(result.message ?? 'Favourite alerts could not be enabled right now.', {
            title: 'Favourite alerts',
            dedupeKey: `favourite-alert-opt-in-${result.status}`,
          });
        }
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : 'Favourite alerts could not be enabled right now.';

        showWarning(message, {
          title: 'Favourite alerts',
          dedupeKey: `favourite-alert-error-${selectedLocation.id}`,
        });
      });
  };

  const handleToggleNavigationPreview = (): void => {
    if (activeRoute) {
      setFollowUserLocation(false);
      clearRoutePreview();
      setExpandedRouteSteps(false);
      showSuccess('Route preview stopped.', {
        title: 'Navigation',
        dedupeKey: `route-preview-stop-${selectedLocation.id}`,
      });
      return;
    }

    if (restrictedLocation) {
      setConfirmRestrictedRoute(true);
      return;
    }

    startNavigationPreview();
  };

  const startNavigationPreview = (): void => {
    if (!userLocation) {
      requestGpsAccess();
      showWarning(
        gpsDiagnostics.status === 'permission-denied'
          ? 'Location permission is blocked. Use the GPS help card above to re-enable it.'
          : 'Requesting your location now. Allow access when your browser prompts you.',
        {
          title: 'GPS access',
          dedupeKey: `gps-request-${selectedLocation.id}-${gpsDiagnostics.status}`,
        }
      );
      return;
    }

    setExpandedRouteSteps(false);
    setFollowUserLocation(false);
    setRoutePreviewActive(true);
  };

  const handleRequestPowerUpdate = (action: CardPowerAction): void => {
    if (powerActionPending || !selectedLocationId) {
      return;
    }

    if (powerUpdateLocked) {
      showWarning('Power updates for this location are locked to admins.', {
        title: 'Power locked',
        dedupeKey: `power-locked-${selectedLocationId}`,
      });
      return;
    }

    if (!isOnline) {
      showWarning('Power updates need a live connection.', {
        title: 'Offline mode',
        dedupeKey: `power-offline-${selectedLocationId}`,
      });
      return;
    }

    if (action === 'turn_on' && powerAlreadyOn) {
      showSuccess(`${selectedLocation.name} is already marked as available.`, {
        title: 'Power status',
        dedupeKey: `power-already-on-${selectedLocationId}`,
      });
      return;
    }

    if (action === 'turn_off' && powerAlreadyOff) {
      showSuccess(`${selectedLocation.name} is already marked as unavailable.`, {
        title: 'Power status',
        dedupeKey: `power-already-off-${selectedLocationId}`,
      });
      return;
    }

    setConfirmPowerAction(action);
  };

  const handleConfirmPowerUpdate = async (): Promise<void> => {
    if (powerActionPending || !selectedLocationId || !confirmPowerAction) {
      return;
    }

    setPowerActionPending(confirmPowerAction);

    try {
      const report = await reportLocationPowerStatus({
        locationId: selectedLocation.id,
        powerStatus: confirmPowerAction === 'turn_on',
      });

      updatePowerSignals([
        {
          locationId: report.locationId,
          powerStatus: report.powerStatus,
          reportedAt: new Date(report.reportedAt).getTime(),
          reportedBy: report.reportedBy ?? null,
        },
      ]);
      setConfirmPowerAction(null);

      showSuccess(`${selectedLocation.name} is now ${report.powerStatus ? 'available' : 'unavailable'}.`, {
        title: 'Power updated',
        dedupeKey: `location-card-power-${selectedLocation.id}-${report.powerStatus ? 'on' : 'off'}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update power right now.';
      showError(message, {
        title: 'Power update failed',
        dedupeKey: `location-card-power-error-${selectedLocation.id}`,
      });
    } finally {
      setPowerActionPending(null);
    }
  };

  const handleRetryGps = (): void => {
    requestGpsAccess();
    showWarning('Retrying GPS now. Check browser and device location settings if it fails again.', {
      title: 'GPS retry',
      dedupeKey: `gps-retry-${selectedLocation.id}`,
    });
  };
  const handleOpenExternalDirections = (): void => {
    const { coordinates } = selectedLocation;
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${coordinates[0]},${coordinates[1]}`;
    window.open(mapsUrl, '_blank', 'noopener,noreferrer');
  };

  const handleShareLocation = async (): Promise<void> => {
    try {
      if (typeof window === 'undefined') {
        return;
      }

      const shareUrl = new URL('/map', window.location.origin);
      shareUrl.searchParams.set('location', selectedLocation.id);
      shareUrl.searchParams.set('source', 'share');

      const shareText = `${selectedLocation.name} (${selectedLocation.type})`;
      const shareUrlString = shareUrl.toString();

      if (navigator.share) {
        await navigator.share({
          title: `${clientConfig.name} location`,
          text: shareText,
          url: shareUrlString,
        });
        showSuccess('Location shared.', {
          title: 'Share ready',
          dedupeKey: `share-location-${selectedLocation.id}`,
        });
        return;
      }

      if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrlString);
        showSuccess('Location link copied to clipboard.', {
          title: 'Copied',
          dedupeKey: `copy-location-${selectedLocation.id}`,
        });
        return;
      }

      showWarning('Sharing is not supported on this device.', {
        title: 'Share unavailable',
        dedupeKey: `share-unsupported-${selectedLocation.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to share location.';
      showError(message, {
        title: 'Share failed',
        dedupeKey: `share-error-${selectedLocation.id}`,
      });
    }
  };

  const handleFocusFellowship = (code: string): void => {
    focusSelectedLocationFellowship(code, null);
    if (!bottomSheetOpen) {
      openBottomSheet();
    }
  };

  const fellowshipSection =
    fellowshipEntries.length > 0 ? (
      <div ref={fellowshipSectionRef}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Fellowships</p>
          <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-700">
            {fellowshipEntries.length} group{fellowshipEntries.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="space-y-3">
          {fellowshipEntries.map((entry) => {
            const fellowshipBrand =
              fellowshipBrandsByCode[normalizeFellowshipCode(entry.code)] ?? null;
            const fellowshipFocused = entry.code === focusedFellowshipCode;
            const orderedServices = [...entry.services].sort((left, right) => {
              const leftFocused = fellowshipFocused && focusedServiceKey === serviceKey(left);
              const rightFocused = fellowshipFocused && focusedServiceKey === serviceKey(right);

              if (leftFocused === rightFocused) {
                return left.dayLabel.localeCompare(right.dayLabel) || left.timeLabel.localeCompare(right.timeLabel);
              }

              return leftFocused ? -1 : 1;
            });

            return (
              <div
                key={entry.code}
                ref={fellowshipFocused ? focusedFellowshipCardRef : null}
                className={`rounded-2xl border px-3 py-3 ${
                  fellowshipFocused
                    ? 'border-cyan-200 bg-cyan-50/70'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <button
                      type="button"
                      onClick={() => handleFocusFellowship(entry.code)}
                      className="flex flex-wrap items-center gap-2 rounded-2xl text-left transition hover:opacity-90 focus:outline-none focus:ring-4 focus:ring-cyan-100"
                    >
                      <FellowshipBrandBadge
                        code={entry.code}
                        logoUrl={fellowshipBrand?.logoUrl ?? null}
                        alt={`${fellowshipBrand?.name ?? entry.name} badge`}
                        className="inline-flex h-10 min-w-[3rem] items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white px-2 py-1"
                        imageClassName="h-full w-full object-contain"
                        fallbackClassName="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-700"
                      />
                      <span className="text-sm font-semibold text-slate-900">{fellowshipBrand?.name ?? entry.name}</span>
                    </button>
                    <p className="mt-1 text-xs text-slate-500">
                      {entry.services.length} service time{entry.services.length === 1 ? '' : 's'} at this venue
                    </p>
                    {(fellowshipBrand?.contact ?? entry.contact) ? (
                      <p className="mt-1 text-xs text-slate-600">Contact: {fellowshipBrand?.contact ?? entry.contact}</p>
                    ) : null}
                  </div>
                  {fellowshipFocused ? (
                    <span className="rounded-full border border-cyan-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-700">
                      Selected
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 space-y-2">
                  {orderedServices.map((service) => {
                    const serviceFocused = fellowshipFocused && focusedServiceKey === serviceKey(service);

                    return (
                      <div
                        key={serviceKey(service)}
                        className={`rounded-2xl border px-3 py-3 ${
                          serviceFocused
                            ? 'border-cyan-300 bg-white shadow-sm'
                            : 'border-slate-200 bg-white/80'
                        }`}
                      >
                        <p className="text-sm font-semibold text-slate-900">{formatFellowshipSchedule(service)}</p>
                        {service.roomLabel ? (
                          <p className="mt-1 text-sm text-slate-700">Room: {service.roomLabel}</p>
                        ) : null}
                        {service.infoLabel ? (
                          <p className="mt-1 text-sm text-slate-600">{service.infoLabel}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  return (
    <>
      {!bottomSheetOpen && !routeStepPreviewOpen && !routeFocusHighlight?.id.startsWith('route_step') && (
        <div className="mobile-bottom-dock pointer-events-none fixed inset-x-0 bottom-24 z-40 px-4 lg:bottom-28">
          <div className="location-preview-shell mx-auto max-w-[520px] lg:ml-auto lg:mr-6 lg:max-w-[390px]">
            <button
              type="button"
              onClick={openBottomSheet}
              className="pointer-events-auto w-full rounded-full border border-white/70 bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow-[0_18px_42px_rgba(15,23,42,0.22)]"
            >
              View location details
            </button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {bottomSheetOpen && (
          <motion.section
            className="mobile-bottom-sheet-padding pointer-events-none fixed inset-0 z-50 flex items-end justify-center px-4 lg:items-end lg:justify-end lg:px-6 lg:pb-28 lg:pt-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="location-info-shell pointer-events-auto bottom-sheet-enter w-full max-w-[520px] overflow-hidden rounded-[30px] border border-white/75 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.28)] lg:max-w-[390px]"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 14, opacity: 0 }}
              transition={{ type: 'spring', damping: 23, stiffness: 270 }}
            >
              <div className="flex items-center justify-between border-b border-slate-200/80 px-5 py-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Selected location</p>
                  <h2 className="mt-1 font-['Outfit'] text-2xl font-semibold text-slate-900">{selectedLocation.name}</h2>
                  <p className="text-sm font-medium text-slate-600">{selectedLocation.type}</p>
                </div>

                <button
                  type="button"
                  onClick={closeBottomSheet}
                  className="panel-close-icon"
                  aria-label="Close location details"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                    <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="max-h-[68vh] space-y-4 overflow-y-auto px-5 py-4 lg:max-h-[60vh]">
                <div className="grid grid-cols-2 gap-3">
                  <div className={`rounded-2xl border px-3 py-3 ${occupancyBadgeStyle}`}>
                    <p className="text-[11px] font-semibold uppercase tracking-wide">Occupancy</p>
                    <p className="mt-1 text-sm font-bold">
                      {occupancy === null ? 'Unavailable' : `${occupancy.toLocaleString()} (${occupancyBand})`}
                    </p>
                  </div>

                  <div className={`rounded-2xl border px-3 py-3 ${powerBadgeStyle}`}>
                    <p className="text-[11px] font-semibold uppercase tracking-wide">Power</p>
                    <p className="mt-1 text-sm font-bold">{powerLabel}</p>
                  </div>
                </div>

                <div className={`rounded-2xl border px-3 py-3 sm:px-4 ${powerControlToneClass}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Power control
                        </span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${powerStatusChipClass}`}>
                          {powerUpdateLocked ? 'Admin locked' : powerLabel}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">
                        Report the current power state from this card.
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600 sm:text-sm">
                        {powerUpdateLocked
                          ? 'Only admins and scheduled actions can change this state.'
                          : powerAlreadyOn
                            ? 'This location is currently marked as having power.'
                            : powerAlreadyOff
                              ? 'This location is currently marked as not having power.'
                              : isOnline
                                ? 'Only submit after confirming the state is accurate.'
                                : 'Reconnect to the internet before sending an update.'}
                      </p>
                    </div>

                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                      {powerUpdateLocked ? 'Locked' : 'Accuracy matters'}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => handleRequestPowerUpdate('turn_on')}
                        disabled={powerTurnOnDisabled}
                        aria-busy={powerActionPending === 'turn_on'}
                        className={`min-h-[56px] rounded-2xl border px-3 py-2.5 text-left transition ${
                          powerTurnOnDisabled
                            ? 'cursor-not-allowed border-slate-200 bg-white text-slate-400'
                            : 'border-emerald-300 bg-emerald-600 text-white shadow-[0_10px_20px_rgba(5,150,105,0.18)] hover:border-emerald-400 hover:bg-emerald-700'
                        }`}
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-80">
                          Turn on
                        </span>
                        <span className="mt-1 block text-sm font-semibold leading-5">{powerTurnOnLabel}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRequestPowerUpdate('turn_off')}
                        disabled={powerTurnOffDisabled}
                        aria-busy={powerActionPending === 'turn_off'}
                        className={`min-h-[56px] rounded-2xl border px-3 py-2.5 text-left transition ${
                          powerTurnOffDisabled
                            ? 'cursor-not-allowed border-slate-200 bg-white text-slate-400'
                            : 'border-rose-300 bg-rose-600 text-white shadow-[0_10px_20px_rgba(225,29,72,0.15)] hover:border-rose-400 hover:bg-rose-700'
                        }`}
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-80">
                          Turn off
                        </span>
                        <span className="mt-1 block text-sm font-semibold leading-5">{powerTurnOffLabel}</span>
                      </button>
                  </div>
                </div>

                {lastUpdated && (
                  <p className="text-xs font-medium text-slate-500">
                    Updated {lastUpdated} {offlineSupportEnabled && !isOnline && '(offline mode)'}
                  </p>
                )}

                {locationFeatures.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Facilities</p>
                    <div className="flex flex-wrap gap-2">
                      {locationFeatures.map((feature, index) => (
                        <span
                          key={`${feature}_${index}`}
                          className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700"
                        >
                          {feature}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {gpsDiagnostics.status !== 'ready' && (
                  <div className={'rounded-2xl border px-3 py-3 ' + gpsPanelToneClass}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">GPS</p>
                        <p className="mt-1 text-sm font-bold">{gpsGuidance.title}</p>
                        <p className="mt-1 text-xs font-medium">{gpsGuidance.summary}</p>
                      </div>
                      {gpsGuidance.canRetry && (
                        <button
                          type="button"
                          onClick={handleRetryGps}
                          className="rounded-full border border-current/30 bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
                        >
                          Retry GPS
                        </button>
                      )}
                    </div>

                    {gpsGuidance.steps.length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs font-medium">
                        {gpsGuidance.steps.map((step, index) => (
                          <li key={'gps_step_' + index} className="flex items-start gap-2">
                            <span className="mt-[2px] inline-block h-1.5 w-1.5 rounded-full bg-current/70" />
                            <span>{step}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {isRouteLoading && (
                  <div className="rounded-2xl border border-sky-200 bg-sky-50 px-3 py-3 text-sky-900">
                    <p className="text-sm font-semibold">Preparing route...</p>
                    <p className="mt-1 text-xs font-medium text-sky-800">
                      {routingState === 'processing'
                        ? 'The map stays interactive while routing data and the exact path prepare in the background.'
                        : 'The map stays interactive while the walking route is built in the background.'}
                    </p>
                  </div>
                )}
                {!isRouteLoading && routePreviewActive && routePreviewStatus === 'error' && routePreviewError && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900">
                    <p className="text-sm font-semibold">Using a simplified route</p>
                    <p className="mt-1 text-xs font-medium text-amber-800">{routePreviewError}</p>
                  </div>
                )}
                {activeRoute && (
                  <div className="rounded-2xl border border-cyan-200 bg-cyan-50/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-800">Route preview</p>
                      <span className="rounded-full border border-cyan-300 bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-700">
                        {isDirectFallbackRoute ? 'Direct fallback' : 'ETA by mode'}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      {routeEtaChips.map((etaChip) => (
                        <span
                          key={etaChip.label}
                          className="rounded-full border border-cyan-300 bg-white px-2.5 py-1 text-xs font-semibold text-cyan-700"
                        >
                          {etaChip.label} {formatEtaMinutes(etaChip.minutes)}
                        </span>
                      ))}
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-cyan-900">
                        {isDirectFallbackRoute
                          ? `${formatMeters(distanceToShow ?? 0)} direct path fallback to this location`
                          : `${formatMeters(distanceToShow ?? 0)} walk from your position`}
                      </p>
                      {liveTrackingEnabled ? (
                        <button
                          type="button"
                          onClick={() => setFollowUserLocation(!followUserLocation)}
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${followUserLocation
                            ? 'border-cyan-500 bg-cyan-600 text-white'
                            : 'border-cyan-300 bg-white text-cyan-700 hover:border-cyan-400'
                            }`}
                        >
                          {followUserLocation ? 'Follow on' : 'Follow off'}
                        </button>
                        ) : null}
                    </div>

                    {activeFallbackReason && (
                      <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900">
                        <p className="text-sm font-semibold">Using a direct path fallback</p>
                        <p className="mt-1 text-xs font-medium text-amber-800">
                          {activeFallbackReason}
                        </p>
                      </div>
                    )}

                    {activeRouteWarningMessage && (
                      <div className="mt-3 rounded-2xl border border-cyan-200 bg-white/80 px-3 py-3 text-cyan-950">
                        <p className="text-sm font-semibold">Route note</p>
                        <p className="mt-1 text-xs font-medium text-cyan-800">
                          {activeRouteWarningMessage}
                        </p>
                      </div>
                    )}

                    {activeRouteTrackingMessage && (
                      <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900">
                        <p className="text-sm font-semibold">{activeRouteTrackingMessage}</p>
                        <p className="mt-1 text-xs font-medium text-amber-800">
                          Keep moving while GPS updates so navigation can rebuild smoothly.
                        </p>
                      </div>
                    )}

                    {!isDirectFallbackRoute && activeRoute.steps.length > 0 && (
                      <p className="mt-2 text-xs font-semibold text-cyan-900">
                        Step {progressStepIndex + 1} of {activeRoute.steps.length} - Next turn {nextTurnLabel}
                      </p>
                    )}

                    {!isDirectFallbackRoute && visibleRouteStepDisplays.length > 0 && (
                      <ol className="mt-3 divide-y divide-slate-200/80 rounded-xl bg-white/85 text-slate-800">
                        {visibleRouteStepDisplays.map((display) => (
                          <li key={display.step.id}>
                            <button
                              type="button"
                              onClick={() => handleRouteStepFocus(display)}
                              className="grid w-full grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-xl px-1 py-3 text-left transition first:pt-2 last:pb-2 hover:bg-cyan-50/70 focus:outline-none focus:ring-2 focus:ring-cyan-300"
                              aria-label={`Show route step on map: ${display.instruction}`}
                            >
                              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center text-slate-600">
                                <ManeuverIcon kind={display.maneuver} />
                              </span>
                              <span className="min-w-0">
                                <span className="block text-base font-medium leading-6 text-slate-900">
                                  {display.instruction}
                                </span>
                                {display.hint && (
                                  <span className="mt-1 flex items-start gap-1.5 text-sm font-semibold leading-5 text-blue-700">
                                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
                                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                                        <path d="M12 10.5v6M12 7.5h.01" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
                                      </svg>
                                    </span>
                                    <span>{display.hint}</span>
                                  </span>
                                )}
                                <span className="mt-3 flex items-center gap-3 text-sm font-medium text-slate-500">
                                  <span>{display.distanceLabel}</span>
                                  <span className="h-px min-w-8 flex-1 bg-slate-200" />
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}

                    {!isDirectFallbackRoute && remainingStepCount > 0 && !expandedRouteSteps && (
                      <button
                        type="button"
                        onClick={() => setExpandedRouteSteps(true)}
                        className="mt-2 text-left text-sm font-semibold text-cyan-800 transition hover:text-cyan-900"
                      >
                        +{remainingStepCount} more steps
                      </button>
                    )}

                    {!isDirectFallbackRoute && expandedRouteSteps && upcomingSteps.length > 4 && (
                      <button
                        type="button"
                        onClick={() => setExpandedRouteSteps(false)}
                        className="mt-2 text-left text-sm font-semibold text-cyan-800 transition hover:text-cyan-900"
                      >
                        Show fewer steps
                      </button>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={handleToggleNavigationPreview}
                    disabled={navigationButtonBusy}
                    aria-busy={navigationButtonBusy}
                    className="primary-cta disabled:opacity-90"
                  >
                    <span>{navigationButtonLabel}</span>
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={handleToggleFavourite} className="secondary-cta">
                      {locationFavourited ? 'Unfavourite' : 'Favourite'}
                    </button>

                    <button type="button" onClick={() => void handleShareLocation()} className="secondary-cta">
                      Share
                    </button>
                  </div>

                  <button type="button" onClick={handleOpenExternalDirections} className="secondary-cta">
                    Open in Google Maps
                  </button>
                </div>

                {fellowshipSection}
              </div>
            </motion.div>
          </motion.section>
        )}
      </AnimatePresence>
      <ConfirmationModal
        open={confirmRestrictedRoute}
        title="Start restricted route?"
        message={`${selectedLocation.name} is marked as restricted. Continue only if you are allowed to access this area.`}
        confirmLabel="Start route"
        onCancel={() => setConfirmRestrictedRoute(false)}
        onConfirm={() => {
          setConfirmRestrictedRoute(false);
          startNavigationPreview();
        }}
      />
      <ConfirmationModal
        open={Boolean(confirmPowerAction)}
        title={confirmPowerAction === 'turn_off' ? 'Confirm power-off update' : 'Confirm power-on update'}
        message={`Only continue if you have personally verified that power is currently ${
          confirmPowerAction === 'turn_off' ? 'unavailable' : 'available'
        } at ${selectedLocation.name}. Inaccurate updates can mislead other users.`}
        confirmLabel={confirmPowerAction === 'turn_off' ? 'Yes, power is off' : 'Yes, power is on'}
        onCancel={() => {
          if (!powerActionPending) {
            setConfirmPowerAction(null);
          }
        }}
        onConfirm={() => {
          void handleConfirmPowerUpdate();
        }}
        busy={Boolean(powerActionPending)}
      />
    </>
  );
  };

export default LocationInfoCard;
