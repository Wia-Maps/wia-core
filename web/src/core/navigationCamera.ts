import { clientConfig } from '../config/client';
import type { MapViewMode } from './mapEngineTypes';
import { haversineDistanceMeters } from './mapMetrics';

export interface NavigationCameraState {
  center: [number, number];
  bearing: number;
  zoom: number;
  pitch: number;
}

interface BuildNavigationCameraTargetOptions {
  location: [number, number];
  remainingPath: [number, number][];
  deviceHeading: number | null | undefined;
  previousBearing: number;
  currentZoom: number;
  currentPitch: number;
  distanceToNextTurnM?: number | null;
  remainingDistanceM?: number | null;
  speedMps?: number | null;
  viewMode: MapViewMode;
}

const EARTH_RADIUS_M = 6378137;

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

export const normalizeBearing = (bearing: number): number => {
  const normalized = bearing % 360;
  return normalized >= 0 ? normalized : normalized + 360;
};

export const shortestAngleDelta = (from: number, to: number): number => {
  return ((to - from + 540) % 360) - 180;
};

export const interpolateBearing = (from: number, to: number, factor: number): number => {
  return normalizeBearing(from + shortestAngleDelta(from, to) * clamp(factor, 0, 1));
};

export const getBearing = (start: [number, number], end: [number, number]): number => {
  const [startLat, startLng] = start;
  const [endLat, endLng] = end;

  const phi1 = (startLat * Math.PI) / 180;
  const phi2 = (endLat * Math.PI) / 180;
  const lambda1 = (startLng * Math.PI) / 180;
  const lambda2 = (endLng * Math.PI) / 180;

  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);

  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
};

const getNextRouteTarget = (
  location: [number, number],
  remainingPath: [number, number][],
  minimumDistanceM: number
): [number, number] | null => {
  for (const point of remainingPath) {
    if (haversineDistanceMeters(location, point) >= minimumDistanceM) {
      return point;
    }
  }

  return remainingPath[remainingPath.length - 1] ?? null;
};

export const projectAheadPoint = (
  start: [number, number],
  bearing: number,
  distanceM: number
): [number, number] => {
  const angularDistance = Math.max(0, distanceM) / EARTH_RADIUS_M;
  const bearingRadians = (bearing * Math.PI) / 180;
  const startLatRadians = (start[0] * Math.PI) / 180;
  const startLngRadians = (start[1] * Math.PI) / 180;

  const nextLat = Math.asin(
    Math.sin(startLatRadians) * Math.cos(angularDistance) +
      Math.cos(startLatRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians)
  );

  const nextLng =
    startLngRadians +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(startLatRadians),
      Math.cos(angularDistance) - Math.sin(startLatRadians) * Math.sin(nextLat)
    );

  return [(nextLat * 180) / Math.PI, (nextLng * 180) / Math.PI];
};

export const resolveNavigationBearing = ({
  location,
  remainingPath,
  deviceHeading,
  previousBearing,
  speedMps,
}: {
  location: [number, number];
  remainingPath: [number, number][];
  deviceHeading: number | null | undefined;
  previousBearing: number;
  speedMps?: number | null;
}): number => {
  const nextTarget = getNextRouteTarget(location, remainingPath, 7);
  if (nextTarget) {
    const routeBearing = getBearing(location, nextTarget);
    const hasReliableHeading =
      typeof deviceHeading === 'number' &&
      Number.isFinite(deviceHeading) &&
      deviceHeading >= 0 &&
      (speedMps ?? 0) >= 0.35;
    const desiredBearing = hasReliableHeading
      ? interpolateBearing(normalizeBearing(deviceHeading), routeBearing, 0.68)
      : routeBearing;

    return interpolateBearing(previousBearing, desiredBearing, hasReliableHeading ? 0.36 : 0.42);
  }

  if (typeof deviceHeading === 'number' && Number.isFinite(deviceHeading) && deviceHeading >= 0) {
    return interpolateBearing(previousBearing, normalizeBearing(deviceHeading), 0.3);
  }

  return normalizeBearing(previousBearing);
};

export const resolveNavigationZoom = ({
  currentZoom,
  speedMps,
  distanceToNextTurnM,
  remainingDistanceM,
}: {
  currentZoom: number;
  speedMps?: number | null;
  distanceToNextTurnM?: number | null;
  remainingDistanceM?: number | null;
}): number => {
  const speed = Math.max(0, speedMps ?? 0);
  let targetZoom = 18.15;

  if (speed >= 2.2) {
    targetZoom = 17.35;
  } else if (speed >= 1.4) {
    targetZoom = 17.7;
  } else if (speed >= 0.7) {
    targetZoom = 17.95;
  }

  const nextTurnDistance = distanceToNextTurnM ?? Number.POSITIVE_INFINITY;
  if (nextTurnDistance <= 14) {
    targetZoom += 0.42;
  } else if (nextTurnDistance <= 28) {
    targetZoom += 0.22;
  }

  const remainingDistance = remainingDistanceM ?? Number.POSITIVE_INFINITY;
  if (remainingDistance <= 18) {
    targetZoom += 0.35;
  } else if (remainingDistance <= 42) {
    targetZoom += 0.16;
  }

  const smoothedZoom = currentZoom + (targetZoom - currentZoom) * 0.28;
  return clamp(smoothedZoom, clientConfig.map.minZoom, clientConfig.map.maxZoom);
};

export const buildNavigationCameraTarget = ({
  location,
  remainingPath,
  deviceHeading,
  previousBearing,
  currentZoom,
  currentPitch,
  distanceToNextTurnM,
  remainingDistanceM,
  speedMps,
  viewMode,
}: BuildNavigationCameraTargetOptions): NavigationCameraState => {
  const bearing = resolveNavigationBearing({
    location,
    remainingPath,
    deviceHeading,
    previousBearing,
    speedMps,
  });

  const speed = Math.max(0, speedMps ?? 0);
  let lookAheadDistanceM = 18 + speed * 9;

  if ((distanceToNextTurnM ?? Number.POSITIVE_INFINITY) <= 12) {
    lookAheadDistanceM -= 8;
  } else if ((distanceToNextTurnM ?? Number.POSITIVE_INFINITY) <= 24) {
    lookAheadDistanceM -= 4;
  }

  if ((remainingDistanceM ?? Number.POSITIVE_INFINITY) <= 20) {
    lookAheadDistanceM -= 6;
  }

  const center = projectAheadPoint(location, bearing, clamp(lookAheadDistanceM, 10, 34));
  const zoom = resolveNavigationZoom({
    currentZoom,
    speedMps: speed,
    distanceToNextTurnM,
    remainingDistanceM,
  });

  const desiredPitch =
    viewMode === 'flat' ? clientConfig.map.minPitch : clamp(clientConfig.map.pitch, 52, 58);
  const pitch = currentPitch + (desiredPitch - currentPitch) * 0.3;

  return {
    center,
    bearing,
    zoom,
    pitch: clamp(pitch, clientConfig.map.minPitch, clientConfig.map.maxPitch),
  };
};

export const shouldApplyCameraUpdate = (
  current: NavigationCameraState,
  next: NavigationCameraState
): boolean => {
  const centerDistance = haversineDistanceMeters(current.center, next.center);
  const bearingDelta = Math.abs(shortestAngleDelta(current.bearing, next.bearing));
  const zoomDelta = Math.abs(current.zoom - next.zoom);
  const pitchDelta = Math.abs(current.pitch - next.pitch);

  return centerDistance >= 1.4 || bearingDelta >= 2 || zoomDelta >= 0.04 || pitchDelta >= 1;
};
