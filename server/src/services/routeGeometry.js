const EARTH_RADIUS_M = 6371000;

export const ROUTE_NODE_SNAP_THRESHOLD_M = 12;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export const clamp = (min, value, max) => {
  return Math.min(max, Math.max(min, value));
};

export const haversineMeters = (from, to) => {
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;

  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const cloneJson = (value) => JSON.parse(JSON.stringify(value));

export const coordinateToLatLng = (coordinate) => {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return null;
  }

  const longitude = Number(coordinate[0]);
  const latitude = Number(coordinate[1]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return [latitude, longitude];
};

export const latLngToCoordinate = (point) => {
  if (!Array.isArray(point) || point.length < 2) {
    return null;
  }

  const latitude = Number(point[0]);
  const longitude = Number(point[1]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return [longitude, latitude];
};

export const lineStringToLatLngs = (geometry) => {
  if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    throw new Error('Route geometry must be a GeoJSON LineString.');
  }

  const points = geometry.coordinates
    .map((coordinate) => coordinateToLatLng(coordinate))
    .filter((point) => Boolean(point));

  if (points.length < 2) {
    throw new Error('Route geometry must contain at least two valid coordinates.');
  }

  return points;
};

export const latLngsToLineString = (points) => {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('At least two points are required to build a LineString.');
  }

  return {
    type: 'LineString',
    coordinates: points.map((point) => latLngToCoordinate(point)),
  };
};

export const lineDistanceMeters = (points) => {
  let distance = 0;

  for (let index = 1; index < points.length; index += 1) {
    distance += haversineMeters(points[index - 1], points[index]);
  }

  return Math.max(1, Math.round(distance));
};

export const simplifyLatLngPath = (points, thresholdMeters = 2) => {
  if (!Array.isArray(points) || points.length <= 2) {
    return points ?? [];
  }

  const simplified = [points[0]];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1];
    const current = points[index];

    if (haversineMeters(previous, current) >= thresholdMeters) {
      simplified.push(current);
    }
  }

  simplified.push(points[points.length - 1]);
  return simplified;
};

export const asTrimmedString = (value) => {
  return typeof value === 'string' ? value.trim() : '';
};

export const normalizeActor = (actor) => {
  return {
    adminId: asTrimmedString(actor?.adminId) || null,
    email: asTrimmedString(actor?.email) || null,
  };
};

export const resolveCampusId = (value) => {
  return (
    asTrimmedString(value) ||
    asTrimmedString(process.env.DEFAULT_CAMPUS_ID) ||
    asTrimmedString(process.env.CAMPUS_ID) ||
    'default'
  );
};
