const EARTH_RADIUS_M = 6378137;

export const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

export const normalizeHeading = (heading: number): number => {
  const normalized = heading % 360;
  return normalized >= 0 ? normalized : normalized + 360;
};

export const shortestHeadingDelta = (from: number, to: number): number => {
  return ((to - from + 540) % 360) - 180;
};

export const interpolateHeading = (from: number, to: number, factor: number): number => {
  return normalizeHeading(from + shortestHeadingDelta(from, to) * clamp(factor, 0, 1));
};

export const haversineMeters = (from: [number, number], to: [number, number]): number => {
  const dLat = toRadians(to[0] - from[0]);
  const dLng = toRadians(to[1] - from[1]);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(from[0])) *
      Math.cos(toRadians(to[0])) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const bearingBetween = (from: [number, number], to: [number, number]): number => {
  const phi1 = toRadians(from[0]);
  const phi2 = toRadians(to[0]);
  const deltaLambda = toRadians(to[1] - from[1]);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  return normalizeHeading(toDegrees(Math.atan2(y, x)));
};

export const projectAhead = (
  start: [number, number],
  bearingDeg: number,
  distanceM: number
): [number, number] => {
  const angularDistance = Math.max(0, distanceM) / EARTH_RADIUS_M;
  const bearingRadians = toRadians(bearingDeg);
  const startLatRadians = toRadians(start[0]);
  const startLngRadians = toRadians(start[1]);

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

  return [toDegrees(nextLat), toDegrees(nextLng)];
};

export interface LocalProjection {
  origin: [number, number];
  latFactor: number;
  lngFactor: number;
}

export const createLocalProjection = (origin: [number, number]): LocalProjection => ({
  origin,
  latFactor: 110540,
  lngFactor: 111320 * Math.cos(toRadians(origin[0])),
});

export const projectToMeters = (
  point: [number, number],
  projection: LocalProjection
): [number, number] => {
  return [
    (point[1] - projection.origin[1]) * projection.lngFactor,
    (point[0] - projection.origin[0]) * projection.latFactor,
  ];
};

export const unprojectFromMeters = (
  point: [number, number],
  projection: LocalProjection
): [number, number] => {
  return [
    projection.origin[0] + point[1] / projection.latFactor,
    projection.origin[1] + point[0] / projection.lngFactor,
  ];
};
