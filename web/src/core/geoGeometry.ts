import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { clientConfig } from '../config/client';

type FeatureLike = {
  id?: string | number;
  geometry: Geometry | null | undefined;
  properties?: Record<string, unknown> | null | undefined;
};

export type RoutingAccessMode = 'auto' | 'open_area' | 'entrance';

const BLOCKING_STRUCTURE_TOKENS = [
  'building',
  'school',
  'residential',
  'hostel',
  'hall',
  'facility',
  'faculty',
  'office',
  'administration',
  'admin',
  'gatehouse',
  'kiosk',
  'clinic',
  'hospital',
  'library',
  'laboratory',
  'laboratory building',
  'laboratory complex',
  'workshop',
  'department',
  'classroom',
  'lecture hall',
  'health centre',
  'health center',
];

const OPEN_GROUND_TOKENS = [
  'pitch',
  'football',
  'soccer',
  'field',
  'park',
  'lot',
  'parking',
  'car park',
  'carpark',
  'garden',
  'playground',
  'court',
  'track',
  'stadium',
  'plaza',
  'square',
  'courtyard',
  'quadrangle',
  'quad',
  'green',
  'open',
];

const SEGMENT_INTERSECTION_T_EPSILON = 0.000001;
const SEGMENT_INTERIOR_SAMPLE_TS = [0.2, 0.35, 0.5, 0.65, 0.8] as const;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const toLngLat = (coordinates: unknown): [number, number] | null => {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const lng = Number(coordinates[0]);
  const lat = Number(coordinates[1]);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }

  return [lng, lat];
};

const isClosedRingDuplicate = (ring: Position[], index: number): boolean => {
  if (ring.length < 2 || index !== ring.length - 1) {
    return false;
  }

  const first = toLngLat(ring[0]);
  const last = toLngLat(ring[index]);
  return Boolean(first && last && first[0] === last[0] && first[1] === last[1]);
};

const averageRingPosition = (ring: Position[]): [number, number] | null => {
  let lngSum = 0;
  let latSum = 0;
  let count = 0;

  ring.forEach((position, index) => {
    if (isClosedRingDuplicate(ring, index)) {
      return;
    }

    const lngLat = toLngLat(position);
    if (!lngLat) {
      return;
    }

    lngSum += lngLat[0];
    latSum += lngLat[1];
    count += 1;
  });

  if (count === 0) {
    return null;
  }

  return [lngSum / count, latSum / count];
};

const outerRingAreaCentroid = (
  ring: Position[]
): { area: number; centroid: [number, number] } | null => {
  let twiceSignedArea = 0;
  let centroidLng = 0;
  let centroidLat = 0;

  for (let index = 0; index < ring.length; index += 1) {
    if (isClosedRingDuplicate(ring, index)) {
      continue;
    }

    const current = toLngLat(ring[index]);
    const next = toLngLat(ring[(index + 1) % ring.length]);
    if (!current || !next) {
      continue;
    }

    const cross = current[0] * next[1] - next[0] * current[1];
    twiceSignedArea += cross;
    centroidLng += (current[0] + next[0]) * cross;
    centroidLat += (current[1] + next[1]) * cross;
  }

  const area = twiceSignedArea / 2;
  if (Math.abs(area) < Number.EPSILON) {
    const average = averageRingPosition(ring);
    if (!average) {
      return null;
    }

    return {
      area: 0,
      centroid: average,
    };
  }

  return {
    area: Math.abs(area),
    centroid: [centroidLng / (3 * twiceSignedArea), centroidLat / (3 * twiceSignedArea)],
  };
};

const geometryOuterRings = (geometry: Geometry | null | undefined): Position[][] => {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return Array.isArray(geometry.coordinates[0]) ? [geometry.coordinates[0] as Position[]] : [];
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((polygon) => (Array.isArray(polygon[0]) ? (polygon[0] as Position[]) : null))
      .filter((ring): ring is Position[] => Array.isArray(ring));
  }

  return [];
};

export const resolveFeatureAnchorCoordinates = (
  feature: FeatureLike | null | undefined
): [number, number] => {
  if (!feature?.geometry) {
    return clientConfig.map.center;
  }

  if (feature.geometry.type === 'Point') {
    const lngLat = toLngLat(feature.geometry.coordinates);
    return lngLat ? [lngLat[1], lngLat[0]] : clientConfig.map.center;
  }

  const bestRing = geometryOuterRings(feature.geometry).reduce<{
    area: number;
    centroid: [number, number];
  } | null>((currentBest, ring) => {
    const candidate = outerRingAreaCentroid(ring);
    if (!candidate) {
      return currentBest;
    }

    if (!currentBest || candidate.area > currentBest.area) {
      return candidate;
    }

    return currentBest;
  }, null);

  if (!bestRing) {
    return clientConfig.map.center;
  }

  return [bestRing.centroid[1], bestRing.centroid[0]];
};

const normalizeText = (value: unknown): string => {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const normalizeRoutingAccessMode = (value: unknown): RoutingAccessMode | null => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  if (normalized === 'open_area' || normalized === 'open-area' || normalized === 'open area') {
    return 'open_area';
  }

  if (
    normalized === 'entrance' ||
    normalized === 'entrance_based' ||
    normalized === 'entrance-based' ||
    normalized === 'entrance based' ||
    normalized === 'gate_only' ||
    normalized === 'gate-only' ||
    normalized === 'gate only'
  ) {
    return 'entrance';
  }

  if (normalized === 'auto') {
    return 'auto';
  }

  return null;
};

const featureProperties = (feature: FeatureLike | null | undefined): Record<string, unknown> => {
  if (!feature?.properties || typeof feature.properties !== 'object' || Array.isArray(feature.properties)) {
    return {};
  }

  return feature.properties;
};

export const isBoundaryFeature = (feature: FeatureLike | null | undefined): boolean => {
  const properties = featureProperties(feature);
  const type = normalizeText(properties.type);
  const kind = normalizeText(properties.kind);
  const routingAccess = normalizeText(properties.routing_access);

  return (
    properties.fence === true ||
    type === 'fence' ||
    type === 'compound' ||
    kind === 'fence' ||
    kind === 'compound' ||
    routingAccess === 'gate_only' ||
    routingAccess === 'gate-only' ||
    routingAccess === 'gate only'
  );
};

const featureHasOpenGroundHints = (feature: FeatureLike | null | undefined): boolean => {
  const properties = featureProperties(feature);
  const values = [
    properties.leisure,
    properties.sport,
    properties.type,
    properties.category,
    properties.landuse,
    properties.name,
  ];

  return values.some((value) => {
    const normalized = normalizeText(value);
    return normalized.length > 0 && OPEN_GROUND_TOKENS.some((token) => normalized.includes(token));
  });
};

const featureHasStrongOpenAreaHints = (feature: FeatureLike | null | undefined): boolean => {
  const properties = featureProperties(feature);
  const amenity = normalizeText(properties.amenity);
  const parking = normalizeText(properties.parking);
  const leisure = normalizeText(properties.leisure);
  const sport = normalizeText(properties.sport);

  if (amenity === 'parking') {
    return true;
  }

  if (parking && !['no', 'false', '0'].includes(parking)) {
    return true;
  }

  if (
    leisure &&
    ['pitch', 'park', 'playground', 'track', 'stadium', 'garden', 'square', 'plaza', 'courtyard'].some(
      (token) => leisure.includes(token)
    )
  ) {
    return true;
  }

  return sport.length > 0;
};

const featureHasBlockingStructureHints = (feature: FeatureLike | null | undefined): boolean => {
  const properties = featureProperties(feature);
  const values = [
    properties.type,
    properties.category,
    properties.amenity,
    properties.office,
    properties.tourism,
    properties.healthcare,
    properties.shop,
    properties.name,
  ];

  return values.some((value) => {
    const normalized = normalizeText(value);
    return normalized.length > 0 && BLOCKING_STRUCTURE_TOKENS.some((token) => normalized.includes(token));
  });
};

const isPolygonalGeometry = (geometry: Geometry | null | undefined): boolean => {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
};

const geometryRings = (geometry: Geometry | null | undefined): unknown[][][] => {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return [geometry.coordinates];
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates;
  }

  return [];
};

const projectPointMeters = (
  point: [number, number],
  referenceLat: number
): { x: number; y: number } => {
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));

  return {
    x: point[0] * lngFactor,
    y: point[1] * latFactor,
  };
};

const findSegmentIntersection = (
  segmentStart: [number, number],
  segmentEnd: [number, number],
  ringStart: [number, number],
  ringEnd: [number, number]
): { point: [number, number]; tSegment: number } | null => {
  const referenceLat = (segmentStart[1] + segmentEnd[1] + ringStart[1] + ringEnd[1]) / 4;
  const a = projectPointMeters(segmentStart, referenceLat);
  const b = projectPointMeters(segmentEnd, referenceLat);
  const c = projectPointMeters(ringStart, referenceLat);
  const d = projectPointMeters(ringEnd, referenceLat);

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;

  if (Math.abs(denominator) < Number.EPSILON) {
    return null;
  }

  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const tSegment = (acx * cdy - acy * cdx) / denominator;
  const tRing = (acx * aby - acy * abx) / denominator;

  if (tSegment < 0 || tSegment > 1 || tRing < 0 || tRing > 1) {
    return null;
  }

  const pointX = a.x + abx * tSegment;
  const pointY = a.y + aby * tSegment;
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));

  return {
    point: [pointX / lngFactor, pointY / latFactor],
    tSegment,
  };
};

const midpoint = (start: [number, number], end: [number, number]): [number, number] => {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
};

const interpolatePoint = (
  start: [number, number],
  end: [number, number],
  t: number
): [number, number] => {
  return [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
  ];
};

const segmentCrossesPolygonGeometry = (
  geometry: Geometry | null | undefined,
  segmentStart: [number, number],
  segmentEnd: [number, number]
): boolean => {
  const polygons = geometryRings(geometry);
  if (polygons.length === 0) {
    return false;
  }

  const startInside = geometryContainsPoint(geometry, segmentStart);
  const endInside = geometryContainsPoint(geometry, segmentEnd);

  if (startInside !== endInside || (startInside && endInside)) {
    return true;
  }

  const segmentMidpoint = midpoint(segmentStart, segmentEnd);
  if (geometryContainsPoint(geometry, segmentMidpoint)) {
    return true;
  }

  if (
    SEGMENT_INTERIOR_SAMPLE_TS.some((sampleT) =>
      geometryContainsPoint(geometry, interpolatePoint(segmentStart, segmentEnd, sampleT))
    )
  ) {
    return true;
  }

  const intersections = new Set<string>();

  polygons.forEach((polygon) => {
    polygon.forEach((ring) => {
      if (!Array.isArray(ring) || ring.length === 0) {
        return;
      }

      for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
        const current = toLngLat(ring[index]);
        const previous = toLngLat(ring[previousIndex]);
        if (!current || !previous) {
          continue;
        }

        const intersection = findSegmentIntersection(segmentStart, segmentEnd, previous, current);
        if (!intersection) {
          continue;
        }

        if (
          intersection.tSegment <= SEGMENT_INTERSECTION_T_EPSILON ||
          intersection.tSegment >= 1 - SEGMENT_INTERSECTION_T_EPSILON
        ) {
          continue;
        }

        intersections.add(`${intersection.point[0].toFixed(7)},${intersection.point[1].toFixed(7)}`);
      }
    });
  });

  return intersections.size >= 2;
};

const pointInRing = (point: [number, number], ring: unknown[]): boolean => {
  let inside = false;
  const [x, y] = point;

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = toLngLat(ring[index]);
    const previous = toLngLat(ring[previousIndex]);
    if (!current || !previous) {
      continue;
    }

    const [currentX, currentY] = current;
    const [previousX, previousY] = previous;
    const intersects =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / ((previousY - currentY) || Number.EPSILON) + currentX;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
};

const distancePointToSegmentMeters = (
  point: [number, number],
  segmentStart: [number, number],
  segmentEnd: [number, number]
): number => {
  return projectPointToSegmentMeters(point, segmentStart, segmentEnd).distanceM;
};

const projectPointToSegmentMeters = (
  point: [number, number],
  segmentStart: [number, number],
  segmentEnd: [number, number]
): { point: [number, number]; distanceM: number } => {
  const referenceLat = (point[1] + segmentStart[1] + segmentEnd[1]) / 3;
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));

  const ax = segmentStart[0] * lngFactor;
  const ay = segmentStart[1] * latFactor;
  const bx = segmentEnd[0] * lngFactor;
  const by = segmentEnd[1] * latFactor;
  const px = point[0] * lngFactor;
  const py = point[1] * latFactor;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby;

  let t = 0;
  if (lengthSq > 0) {
    t = (apx * abx + apy * aby) / lengthSq;
  }

  const clampedT = Math.max(0, Math.min(1, t));
  const projX = ax + abx * clampedT;
  const projY = ay + aby * clampedT;

  return {
    point: [projX / lngFactor, projY / latFactor],
    distanceM: Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY)),
  };
};

const distancePointToRingMeters = (point: [number, number], ring: unknown[]): number => {
  if (ring.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let shortestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = toLngLat(ring[index]);
    const previous = toLngLat(ring[previousIndex]);
    if (!current || !previous) {
      continue;
    }

    shortestDistance = Math.min(
      shortestDistance,
      distancePointToSegmentMeters(point, previous, current)
    );
  }

  return shortestDistance;
};

const nearestPointOnRingBoundary = (
  point: [number, number],
  ring: unknown[]
): { point: [number, number]; distanceM: number } | null => {
  if (ring.length === 0) {
    return null;
  }

  let best: { point: [number, number]; distanceM: number } | null = null;

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = toLngLat(ring[index]);
    const previous = toLngLat(ring[previousIndex]);
    if (!current || !previous) {
      continue;
    }

    const projection = projectPointToSegmentMeters(point, previous, current);
    if (!best || projection.distanceM < best.distanceM) {
      best = projection;
    }
  }

  return best;
};

export const pointInPolygon = (point: [number, number], polygon: unknown[]): boolean => {
  if (!Array.isArray(polygon) || polygon.length === 0 || !Array.isArray(polygon[0])) {
    return false;
  }

  const outerRing = polygon[0];
  if (!Array.isArray(outerRing) || !pointInRing(point, outerRing)) {
    return false;
  }

  for (let index = 1; index < polygon.length; index += 1) {
    const innerRing = polygon[index];
    if (Array.isArray(innerRing) && pointInRing(point, innerRing as unknown[])) {
      return false;
    }
  }

  return true;
};

export const geometryContainsPoint = (
  geometry: Geometry | null | undefined,
  point: [number, number]
): boolean => {
  if (!geometry) {
    return false;
  }

  if (geometry.type === 'Polygon') {
    return pointInPolygon(point, geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }

  return false;
};

export const resolveFeatureId = (
  feature: FeatureLike | null | undefined,
  fallback?: string | number | null
): string | null => {
  if (!feature) {
    return null;
  }

  if (typeof feature.id === 'string' && feature.id.trim().length > 0) {
    return feature.id.trim();
  }

  if (typeof feature.id === 'number' && Number.isFinite(feature.id)) {
    return String(feature.id);
  }

  const properties = featureProperties(feature);
  const propertyIdCandidates = [properties.id, properties['@id']];

  for (const candidate of propertyIdCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback.trim();
  }

  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return `feature_${Math.trunc(fallback)}`;
  }

  return null;
};

export const resolveRoutingAccessMode = (
  feature: FeatureLike | null | undefined
): RoutingAccessMode => {
  const properties = featureProperties(feature);
  return normalizeRoutingAccessMode(properties.routing_access) ?? 'auto';
};

export const isOpenAreaFeature = (feature: FeatureLike | null | undefined): boolean => {
  if (!isPolygonalGeometry(feature?.geometry)) {
    return false;
  }

  const routingAccessMode = resolveRoutingAccessMode(feature);
  if (routingAccessMode === 'open_area') {
    return true;
  }

  if (routingAccessMode === 'entrance') {
    return false;
  }

  if (featureHasStrongOpenAreaHints(feature)) {
    return true;
  }

  const properties = featureProperties(feature);
  const building = normalizeText(properties.building);
  if (building && !['no', 'false', '0'].includes(building)) {
    return false;
  }

  if (featureHasBlockingStructureHints(feature)) {
    return false;
  }

  return featureHasOpenGroundHints(feature);
};

export const isBlockingStructureFeature = (feature: FeatureLike | null | undefined): boolean => {
  if (!isPolygonalGeometry(feature?.geometry)) {
    return false;
  }

  if (resolveRoutingAccessMode(feature) === 'open_area' || isOpenAreaFeature(feature)) {
    return false;
  }

  const properties = featureProperties(feature);
  const building = normalizeText(properties.building);

  if (building && !['no', 'false', '0'].includes(building)) {
    return true;
  }

  return featureHasBlockingStructureHints(feature);
};

export type FeatureVisualClass = 'structure' | 'surface' | 'fence';

export type FeatureSurfaceKind =
  | 'parking'
  | 'pitch'
  | 'field'
  | 'court'
  | 'garden'
  | 'plaza'
  | 'track'
  | 'courtyard'
  | 'square'
  | 'open';

export const resolveFeatureVisualClass = (feature: FeatureLike | null | undefined): FeatureVisualClass => {
  if (isBoundaryFeature(feature)) {
    return 'fence';
  }

  return isOpenAreaFeature(feature) ? 'surface' : 'structure';
};

export const resolveFeatureSurfaceKind = (feature: FeatureLike | null | undefined): FeatureSurfaceKind => {
  const properties = featureProperties(feature);
  const values = [
    properties.amenity,
    properties.leisure,
    properties.landuse,
    properties.sport,
    properties.type,
    properties.category,
    properties.name,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  const matches = (tokens: string[]): boolean => values.some((value) => tokens.some((token) => value.includes(token)));

  if (matches(['parking', 'car park', 'carpark', 'parkade'])) {
    return 'parking';
  }

  if (matches(['pitch', 'football', 'soccer'])) {
    return 'pitch';
  }

  if (matches(['field', 'green'])) {
    return 'field';
  }

  if (matches(['court', 'tennis', 'basketball', 'volleyball', 'badminton'])) {
    return 'court';
  }

  if (matches(['track', 'athletics', 'running'])) {
    return 'track';
  }

  if (matches(['garden'])) {
    return 'garden';
  }

  if (matches(['plaza', 'square', 'courtyard', 'quad', 'quadrangle'])) {
    return 'plaza';
  }

  if (matches(['courtyard'])) {
    return 'courtyard';
  }

  return 'open';
};

export const collectBlockingStructureFeatures = (
  collection: FeatureCollection<Geometry, Record<string, unknown>> | null | undefined
): Array<Feature<Geometry, Record<string, unknown>>> => {
  if (!collection?.features?.length) {
    return [];
  }

  return collection.features.filter(
    (feature): feature is Feature<Geometry, Record<string, unknown>> => isBlockingStructureFeature(feature)
  );
};

export const geometryDistanceToPointMeters = (
  geometry: Geometry | null | undefined,
  point: [number, number]
): number => {
  if (!geometry) {
    return Number.POSITIVE_INFINITY;
  }

  if (geometry.type === 'Polygon') {
    if (pointInPolygon(point, geometry.coordinates)) {
      return 0;
    }

    return geometry.coordinates.reduce((shortestDistance, ring) => {
      if (!Array.isArray(ring)) {
        return shortestDistance;
      }

      return Math.min(shortestDistance, distancePointToRingMeters(point, ring));
    }, Number.POSITIVE_INFINITY);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((shortestDistance, polygon) => {
      return Math.min(shortestDistance, geometryDistanceToPointMeters({
        type: 'Polygon',
        coordinates: polygon,
      }, point));
    }, Number.POSITIVE_INFINITY);
  }

  return Number.POSITIVE_INFINITY;
};

export const nearestPointOnGeometryBoundary = (
  geometry: Geometry | null | undefined,
  point: [number, number]
): [number, number] | null => {
  if (!geometry) {
    return null;
  }

  if (geometry.type === 'Polygon') {
    let bestPoint: [number, number] | null = null;
    let bestDistanceM = Number.POSITIVE_INFINITY;

    geometry.coordinates.forEach((ring) => {
      if (!Array.isArray(ring)) {
        return;
      }

      const candidate = nearestPointOnRingBoundary(point, ring);
      if (!candidate) {
        return;
      }

      if (candidate.distanceM < bestDistanceM) {
        bestPoint = candidate.point;
        bestDistanceM = candidate.distanceM;
      }
    });

    return bestPoint;
  }

  if (geometry.type === 'MultiPolygon') {
    let bestPoint: [number, number] | null = null;
    let bestDistanceM = Number.POSITIVE_INFINITY;

    geometry.coordinates.forEach((polygon) => {
      const candidatePoint = nearestPointOnGeometryBoundary(
        {
          type: 'Polygon',
          coordinates: polygon,
        },
        point
      );

      if (!candidatePoint) {
        return;
      }

      const distanceM = distancePointToSegmentMeters(point, candidatePoint, candidatePoint);
      if (distanceM < bestDistanceM) {
        bestPoint = candidatePoint;
        bestDistanceM = distanceM;
      }
    });

    return bestPoint;
  }

  return null;
};

export const geometryBoundaryDistanceToPointMeters = (
  geometry: Geometry | null | undefined,
  point: [number, number]
): number => {
  const boundaryPoint = nearestPointOnGeometryBoundary(geometry, point);
  if (!boundaryPoint) {
    return Number.POSITIVE_INFINITY;
  }

  return distancePointToSegmentMeters(point, boundaryPoint, boundaryPoint);
};

export const featureContainsPoint = (
  feature: { geometry: Geometry | null | undefined } | null | undefined,
  point: [number, number]
): boolean => {
  return geometryContainsPoint(feature?.geometry, point);
};

export const featureDistanceToPointMeters = (
  feature: { geometry: Geometry | null | undefined } | null | undefined,
  point: [number, number]
): number => {
  return geometryDistanceToPointMeters(feature?.geometry, point);
};

export const featureBoundaryPointNearestToPoint = (
  feature: { geometry: Geometry | null | undefined } | null | undefined,
  point: [number, number]
): [number, number] | null => {
  return nearestPointOnGeometryBoundary(feature?.geometry, point);
};

export const featureBoundaryDistanceToPointMeters = (
  feature: { geometry: Geometry | null | undefined } | null | undefined,
  point: [number, number]
): number => {
  return geometryBoundaryDistanceToPointMeters(feature?.geometry, point);
};

export const collectGeometryBoundarySamplePoints = (
  geometry: Geometry | null | undefined
): [number, number][] => {
  const samplePoints: [number, number][] = [];
  const seen = new Set<string>();

  const pushPoint = (point: [number, number]): void => {
    const key = `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    samplePoints.push(point);
  };

  geometryRings(geometry).forEach((polygon) => {
    polygon.forEach((ring) => {
      if (!Array.isArray(ring) || ring.length === 0) {
        return;
      }

      for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
        const current = toLngLat(ring[index]);
        const previous = toLngLat(ring[previousIndex]);
        if (!current || !previous) {
          continue;
        }

        pushPoint(current);
        pushPoint(midpoint(previous, current));
      }
    });
  });

  return samplePoints;
};

export const collectFeatureBoundarySamplePoints = (
  feature: { geometry: Geometry | null | undefined } | null | undefined
): [number, number][] => {
  return collectGeometryBoundarySamplePoints(feature?.geometry);
};

export const segmentCrossesBlockingStructures = (
  segmentStart: [number, number],
  segmentEnd: [number, number],
  input:
    | ReadonlyArray<FeatureLike>
    | FeatureCollection<Geometry, Record<string, unknown>>
    | null
    | undefined,
  options?: {
    allowedLocationIds?: Iterable<string> | null;
  }
): boolean => {
  const features: ReadonlyArray<FeatureLike> = Array.isArray(input)
    ? input
    : collectBlockingStructureFeatures(input as FeatureCollection<Geometry, Record<string, unknown>> | null | undefined);
  if (features.length === 0) {
    return false;
  }

  const allowedLocationIds = new Set(Array.from(options?.allowedLocationIds ?? []).filter(Boolean));

  return features.some((feature, index) => {
    if (!isBlockingStructureFeature(feature)) {
      return false;
    }

    const featureId = resolveFeatureId(feature, index);
    if (featureId && allowedLocationIds.has(featureId)) {
      return false;
    }

    return segmentCrossesPolygonGeometry(feature.geometry, segmentStart, segmentEnd);
  });
};
