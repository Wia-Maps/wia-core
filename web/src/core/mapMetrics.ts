export interface ScreenPoint {
  x: number;
  y: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const haversineDistanceMeters = (
  from: [number, number],
  to: [number, number]
): number => {
  const earthRadius = 6371000;
  const dLat = toRadians(to[0] - from[0]);
  const dLng = toRadians(to[1] - from[1]);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(from[0])) *
      Math.cos(toRadians(to[0])) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

