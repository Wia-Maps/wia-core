import { useEffect, useMemo, useRef } from 'react';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import {
  featureContainsPoint,
  featureDistanceToPointMeters,
  isBoundaryFeature,
  resolveFeatureId,
} from './geoGeometry';
import { useToast } from '../context/ToastContext';
import { haversineDistanceMeters } from './mapMetrics';
import type {
  RouteAccessibilityMode,
  RoutePreview,
  SelectedLocation,
  UserMotion,
} from '../store/useAppStore';

const NEAR_DISTANCE_THRESHOLD_M = 60;
const NEAR_ETA_THRESHOLD_MIN = 1;
const ARRIVAL_POLYGON_BOUNDARY_THRESHOLD_M = 10;
const ARRIVAL_POINT_THRESHOLD_M = 12;
const ARRIVAL_ROUTE_DISTANCE_THRESHOLD_M = 12;
const ARRIVAL_ACCURACY_MAX_M = 35;
const CONSECUTIVE_SAMPLE_THRESHOLD = 2;

interface NavigationFeedbackLayerProps {
  routePreviewActive: boolean;
  routePreview: RoutePreview | null;
  selectedLocation: SelectedLocation | null;
  userLocation: [number, number] | null;
  userMotion: UserMotion;
  geojsonData?: FeatureCollection<Geometry, Record<string, unknown>> | null;
  routeAccessibilityMode: RouteAccessibilityMode;
  onArrive: () => void;
}

type CampusFeature = Feature<Geometry, Record<string, unknown>>;

const formatMeters = (distance: number): string => {
  if (!Number.isFinite(distance) || distance <= 0) {
    return '0 m';
  }

  if (distance >= 1000) {
    return `${(distance / 1000).toFixed(1)} km`;
  }

  return `${Math.max(0, Math.round(distance))} m`;
};

const formatEtaMinutes = (minutes: number): string => {
  const roundedMinutes = Math.max(0, Math.round(minutes));
  if (roundedMinutes <= 0) {
    return 'Under 1 min';
  }

  if (roundedMinutes < 60) {
    return `${roundedMinutes} min`;
  }

  const hours = Math.floor(roundedMinutes / 60);
  const remainingMinutes = roundedMinutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${remainingMinutes} min`;
};

const distanceMeters = (from: [number, number], to: [number, number]): number => {
  return haversineDistanceMeters(from, to);
};

const isPolygonalFeature = (feature: CampusFeature | null): boolean => {
  return Boolean(
    feature && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')
  );
};

export function NavigationFeedbackLayer({
  routePreviewActive,
  routePreview,
  selectedLocation,
  userLocation,
  userMotion,
  geojsonData,
  routeAccessibilityMode,
  onArrive,
}: NavigationFeedbackLayerProps): null {
  const { showToast } = useToast();
  const hasShownNearToastRef = useRef(false);
  const hasShownArrivalToastRef = useRef(false);
  const nearSampleStreakRef = useRef(0);
  const arrivalSampleStreakRef = useRef(0);

  const destinationId = routePreview?.destination_id ?? selectedLocation?.id ?? null;
  const sessionKey = routePreviewActive
    ? `${destinationId ?? 'none'}:${routeAccessibilityMode}`
    : 'inactive';

  const destinationFeature = useMemo<CampusFeature | null>(() => {
    if (!geojsonData?.features?.length || !destinationId) {
      return null;
    }

    return (
      geojsonData.features.find(
        (feature, index): feature is CampusFeature => resolveFeatureId(feature, index) === destinationId
      ) ?? null
    );
  }, [destinationId, geojsonData]);

  useEffect(() => {
    hasShownNearToastRef.current = false;
    hasShownArrivalToastRef.current = false;
    nearSampleStreakRef.current = 0;
    arrivalSampleStreakRef.current = 0;
  }, [sessionKey]);

  useEffect(() => {
    if (!routePreviewActive || !routePreview || !selectedLocation || !userLocation) {
      return;
    }

    if (routePreview.arrival_eligible === false) {
      nearSampleStreakRef.current = 0;
      arrivalSampleStreakRef.current = 0;
      return;
    }

    const remainingDistanceM = routePreview.remaining_distance_m ?? routePreview.distance_m;
    const remainingEtaMin = routePreview.eta_smoothed_min ?? routePreview.eta_min;
    const onRoute = routePreview.tracking_status !== 'off_route';
    const poorAccuracy =
      typeof userMotion.accuracyM === 'number' && userMotion.accuracyM > ARRIVAL_ACCURACY_MAX_M;
    const userPoint: [number, number] = [userLocation[1], userLocation[0]];
    const polygonDestination = isPolygonalFeature(destinationFeature);
    const boundaryDestination = destinationFeature ? isBoundaryFeature(destinationFeature) : false;
    const destinationAccessPoint = routePreview.destination_access_point ?? selectedLocation.coordinates;
    const insideDestinationPolygon = polygonDestination
      ? featureContainsPoint(destinationFeature, userPoint)
      : false;
    const polygonBoundaryDistanceM = polygonDestination
      ? featureDistanceToPointMeters(destinationFeature, userPoint)
      : Number.POSITIVE_INFINITY;
    const pointFallbackDistanceM = distanceMeters(userLocation, destinationAccessPoint);

    const arrivedByPolygonContainment = polygonDestination && !boundaryDestination && insideDestinationPolygon;
    const arrivedByPolygonBoundary =
      polygonDestination &&
      !boundaryDestination &&
      !poorAccuracy &&
      Number.isFinite(polygonBoundaryDistanceM) &&
      polygonBoundaryDistanceM <= ARRIVAL_POLYGON_BOUNDARY_THRESHOLD_M;
    const arrivedByPointFallback =
      !polygonDestination &&
      !poorAccuracy &&
      pointFallbackDistanceM <= ARRIVAL_POINT_THRESHOLD_M;
    const arrivedByRouteProgress = onRoute && remainingDistanceM <= ARRIVAL_ROUTE_DISTANCE_THRESHOLD_M;

    const shouldArrive =
      arrivedByPolygonContainment ||
      arrivedByPolygonBoundary ||
      arrivedByPointFallback ||
      arrivedByRouteProgress;

    if (shouldArrive) {
      arrivalSampleStreakRef.current += 1;
    } else {
      arrivalSampleStreakRef.current = 0;
    }

    if (
      arrivalSampleStreakRef.current >= CONSECUTIVE_SAMPLE_THRESHOLD &&
      !hasShownArrivalToastRef.current
    ) {
      hasShownArrivalToastRef.current = true;
      showToast({
        type: 'success',
        title: 'You made it',
        message: `Welcome to ${selectedLocation.name}.`,
        visualStyle: 'arrival-celebration',
        durationMs: 6500,
        dedupeKey: `navigation-arrival-${sessionKey}`,
      });
      onArrive();
      return;
    }

    if (shouldArrive) {
      return;
    }

    if (hasShownNearToastRef.current) {
      return;
    }

    const nearThresholdReached =
      onRoute &&
      (remainingDistanceM <= NEAR_DISTANCE_THRESHOLD_M || remainingEtaMin <= NEAR_ETA_THRESHOLD_MIN);

    if (nearThresholdReached) {
      nearSampleStreakRef.current += 1;
    } else {
      nearSampleStreakRef.current = 0;
    }

    if (nearSampleStreakRef.current < CONSECUTIVE_SAMPLE_THRESHOLD) {
      return;
    }

    hasShownNearToastRef.current = true;
    showToast({
      type: 'success',
      title: 'Almost there',
      message: `${selectedLocation.name} is coming up.`,
      visualStyle: 'navigation-progress',
      stats: [
        { label: 'Left', value: formatMeters(remainingDistanceM) },
        { label: 'ETA', value: formatEtaMinutes(remainingEtaMin) },
      ],
      durationMs: 8000,
      dedupeKey: `navigation-near-${sessionKey}`,
    });
  }, [
    destinationFeature,
    onArrive,
    routePreview,
    routePreviewActive,
    selectedLocation,
    sessionKey,
    showToast,
    userLocation,
    userMotion.accuracyM,
  ]);

  return null;
}
