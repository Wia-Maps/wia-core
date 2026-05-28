import type { LineString, Position } from 'geojson';

export type RouteCleanupPoint = [number, number];
export type RouteCleanupIssueType = 'duplicate_overlap' | 'circular_jitter';
export type RouteCleanupIssueStatus = 'pending' | 'accepted' | 'dismissed';
export type RouteCleanupSuggestionSource = 'editor' | 'worker';

export interface RouteCleanupIssue {
  id: string;
  type: RouteCleanupIssueType;
  title: string;
  message: string;
  confidence: number;
  source: RouteCleanupSuggestionSource;
  status: RouteCleanupIssueStatus;
  affectedPointIndexes: [number, number];
  metrics: Record<string, number>;
  proposedGeometry: LineString;
}

export interface RouteCleanupMetadata {
  source: RouteCleanupSuggestionSource;
  originalGeometry: LineString | null;
  proposedGeometry: LineString | null;
  issues: RouteCleanupIssue[];
  updatedAt: string;
}

interface RouteCleanupAnalysisOptions {
  source?: RouteCleanupSuggestionSource;
  originalGeometry?: LineString | null;
  persistedIssues?: RouteCleanupIssue[];
}

const toRadians = (value: number): number => (value * Math.PI) / 180;

const clamp = (value: number, minimum: number, maximum: number): number => {
  return Math.max(minimum, Math.min(maximum, value));
};

const haversineMeters = (from: RouteCleanupPoint, to: RouteCleanupPoint): number => {
  const earthRadiusM = 6371000;
  const fromLat = toRadians(from[1]);
  const toLat = toRadians(to[1]);
  const deltaLat = toRadians(to[1] - from[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const pathDistanceMeters = (points: RouteCleanupPoint[]): number => {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(points[index - 1], points[index]);
  }
  return total;
};

const normalizeHeading = (heading: number): number => {
  const normalized = heading % 360;
  return normalized >= 0 ? normalized : normalized + 360;
};

const headingDelta = (left: number, right: number): number => {
  const difference = Math.abs(normalizeHeading(left) - normalizeHeading(right));
  return Math.min(difference, 360 - difference);
};

const calculateBearing = (from: RouteCleanupPoint, to: RouteCleanupPoint): number | null => {
  if (from[0] === to[0] && from[1] === to[1]) {
    return null;
  }

  const fromLat = toRadians(from[1]);
  const toLat = toRadians(to[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
};

const cumulativeTurnDegrees = (points: RouteCleanupPoint[]): number => {
  let total = 0;
  let previousBearing: number | null = null;

  for (let index = 1; index < points.length; index += 1) {
    const bearing = calculateBearing(points[index - 1], points[index]);
    if (bearing === null) {
      continue;
    }

    if (previousBearing !== null) {
      total += headingDelta(previousBearing, bearing);
    }
    previousBearing = bearing;
  }

  return total;
};

const projectToLocalXY = (point: RouteCleanupPoint, referenceLatitude: number): [number, number] => {
  const x = toRadians(point[0]) * 6371000 * Math.cos(toRadians(referenceLatitude));
  const y = toRadians(point[1]) * 6371000;
  return [x, y];
};

const pointToSegmentDistanceMeters = (
  point: RouteCleanupPoint,
  start: RouteCleanupPoint,
  end: RouteCleanupPoint
): number => {
  const referenceLatitude = (point[1] + start[1] + end[1]) / 3;
  const [px, py] = projectToLocalXY(point, referenceLatitude);
  const [sx, sy] = projectToLocalXY(start, referenceLatitude);
  const [ex, ey] = projectToLocalXY(end, referenceLatitude);
  const dx = ex - sx;
  const dy = ey - sy;

  if (dx === 0 && dy === 0) {
    return Math.hypot(px - sx, py - sy);
  }

  const projection = clamp(((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy), 0, 1);
  const closestX = sx + projection * dx;
  const closestY = sy + projection * dy;
  return Math.hypot(px - closestX, py - closestY);
};

const maxDeviationFromStraightLine = (points: RouteCleanupPoint[]): number => {
  if (points.length <= 2) {
    return 0;
  }

  const start = points[0];
  const end = points[points.length - 1];
  let maxDeviation = 0;

  for (let index = 1; index < points.length - 1; index += 1) {
    maxDeviation = Math.max(maxDeviation, pointToSegmentDistanceMeters(points[index], start, end));
  }

  return maxDeviation;
};

const maxPairDistanceMeters = (points: RouteCleanupPoint[]): number => {
  let maxDistance = 0;
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      maxDistance = Math.max(maxDistance, haversineMeters(points[leftIndex], points[rightIndex]));
    }
  }
  return maxDistance;
};

const toPosition = (point: RouteCleanupPoint): Position => [point[0], point[1]];

export const pointsToCleanupGeometry = (points: RouteCleanupPoint[]): LineString => ({
  type: 'LineString',
  coordinates: points.map((point) => toPosition(point)),
});

export const geometryToCleanupPoints = (geometry: LineString | null | undefined): RouteCleanupPoint[] => {
  if (!geometry || geometry.type !== 'LineString') {
    return [];
  }

  return geometry.coordinates
    .map((position) => {
      if (!Array.isArray(position) || position.length < 2) {
        return null;
      }

      const lng = Number(position[0]);
      const lat = Number(position[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return null;
      }

      return [lng, lat] satisfies RouteCleanupPoint;
    })
    .filter((point): point is RouteCleanupPoint => Boolean(point));
};

const replaceWindowWithStraightSegment = (
  points: RouteCleanupPoint[],
  startIndex: number,
  endIndex: number
): RouteCleanupPoint[] => {
  const startPoint = points[startIndex];
  const endPoint = points[endIndex];
  const replacement =
    haversineMeters(startPoint, endPoint) >= 1
      ? [startPoint, endPoint]
      : [startPoint];

  return [
    ...points.slice(0, startIndex),
    ...replacement,
    ...points.slice(endIndex + 1),
  ];
};

const buildIssueId = (
  type: RouteCleanupIssueType,
  startIndex: number,
  endIndex: number,
  metrics: Record<string, number>
): string => {
  return [
    type,
    startIndex,
    endIndex,
    Math.round(metrics.pathDistanceM || 0),
    Math.round(metrics.displacementM || 0),
    Math.round(metrics.turnDegrees || 0),
  ].join(':');
};

const buildIssue = (
  type: RouteCleanupIssueType,
  title: string,
  message: string,
  confidence: number,
  source: RouteCleanupSuggestionSource,
  startIndex: number,
  endIndex: number,
  metrics: Record<string, number>,
  points: RouteCleanupPoint[]
): RouteCleanupIssue => {
  return {
    id: buildIssueId(type, startIndex, endIndex, metrics),
    type,
    title,
    message,
    confidence: Math.round(clamp(confidence, 0, 0.99) * 1000) / 1000,
    source,
    status: 'pending',
    affectedPointIndexes: [startIndex, endIndex],
    metrics,
    proposedGeometry: pointsToCleanupGeometry(replaceWindowWithStraightSegment(points, startIndex, endIndex)),
  };
};

const detectCircularJitterIssues = (
  points: RouteCleanupPoint[],
  source: RouteCleanupSuggestionSource
): RouteCleanupIssue[] => {
  const suggestions: RouteCleanupIssue[] = [];
  const maxWindowSize = Math.min(points.length, 12);

  for (let windowSize = 5; windowSize <= maxWindowSize; windowSize += 1) {
    for (let startIndex = 0; startIndex + windowSize <= points.length; startIndex += 1) {
      const endIndex = startIndex + windowSize - 1;
      const windowPoints = points.slice(startIndex, endIndex + 1);
      const pathDistanceM = pathDistanceMeters(windowPoints);
      const displacementM = haversineMeters(windowPoints[0], windowPoints[windowPoints.length - 1]);
      const diameterM = maxPairDistanceMeters(windowPoints);
      const turnDegrees = cumulativeTurnDegrees(windowPoints);
      const maxDeviationM = maxDeviationFromStraightLine(windowPoints);
      const loopinessRatio = pathDistanceM / Math.max(displacementM, 1);

      if (pathDistanceM < 14 || displacementM < 2.5) {
        continue;
      }
      if (loopinessRatio < 2.2 || displacementM > Math.min(12, pathDistanceM * 0.42)) {
        continue;
      }
      if (diameterM > 26 || turnDegrees < 255 || maxDeviationM < 3) {
        continue;
      }

      const confidence =
        0.64 +
        Math.min(0.18, (turnDegrees - 255) / 360) +
        Math.min(0.12, (loopinessRatio - 2.2) * 0.08) -
        Math.min(0.12, diameterM / 260);

      suggestions.push(
        buildIssue(
          'circular_jitter',
          'Circular GPS jitter detected',
          'This stretch loops around in a tight circle and can usually be straightened before review.',
          confidence,
          source,
          startIndex,
          endIndex,
          {
            pathDistanceM: Math.round(pathDistanceM),
            displacementM: Math.round(displacementM),
            diameterM: Math.round(diameterM),
            turnDegrees: Math.round(turnDegrees),
            maxDeviationM: Math.round(maxDeviationM),
          },
          points
        )
      );
    }
  }

  return suggestions;
};

const detectDuplicateOverlapIssues = (
  points: RouteCleanupPoint[],
  source: RouteCleanupSuggestionSource
): RouteCleanupIssue[] => {
  const suggestions: RouteCleanupIssue[] = [];
  const maxWindowSize = Math.min(points.length, 13);

  for (let windowSize = 5; windowSize <= maxWindowSize; windowSize += 1) {
    for (let startIndex = 0; startIndex + windowSize <= points.length; startIndex += 1) {
      const endIndex = startIndex + windowSize - 1;
      const windowPoints = points.slice(startIndex, endIndex + 1);
      const pathDistanceM = pathDistanceMeters(windowPoints);
      const displacementM = haversineMeters(windowPoints[0], windowPoints[windowPoints.length - 1]);
      const maxDeviationM = maxDeviationFromStraightLine(windowPoints);
      const turnDegrees = cumulativeTurnDegrees(windowPoints);
      const corridorRatio = pathDistanceM / Math.max(displacementM, 1);

      if (pathDistanceM < 18 || displacementM < 8) {
        continue;
      }
      if (corridorRatio < 1.38 || corridorRatio > 2.9) {
        continue;
      }
      if (maxDeviationM > 8.5 || turnDegrees > 250 || turnDegrees < 35) {
        continue;
      }

      const confidence =
        0.58 +
        Math.min(0.16, (corridorRatio - 1.38) * 0.22) +
        Math.min(0.12, Math.max(0, 8.5 - maxDeviationM) / 28) -
        Math.min(0.1, turnDegrees / 420);

      suggestions.push(
        buildIssue(
          'duplicate_overlap',
          'Duplicated path overlap detected',
          'This section appears to double over the same corridor and can often be reduced to a single cleaner line.',
          confidence,
          source,
          startIndex,
          endIndex,
          {
            pathDistanceM: Math.round(pathDistanceM),
            displacementM: Math.round(displacementM),
            corridorRatio: Math.round(corridorRatio * 100) / 100,
            turnDegrees: Math.round(turnDegrees),
            maxDeviationM: Math.round(maxDeviationM),
          },
          points
        )
      );
    }
  }

  return suggestions;
};

const rangesSubstantiallyOverlap = (
  left: [number, number],
  right: [number, number]
): boolean => {
  const overlapStart = Math.max(left[0], right[0]);
  const overlapEnd = Math.min(left[1], right[1]);
  const overlapLength = Math.max(0, overlapEnd - overlapStart + 1);
  const leftLength = left[1] - left[0] + 1;
  const rightLength = right[1] - right[0] + 1;

  return overlapLength / Math.max(1, Math.min(leftLength, rightLength)) >= 0.65;
};

const dedupeIssues = (issues: RouteCleanupIssue[]): RouteCleanupIssue[] => {
  const ordered = [...issues].sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.affectedPointIndexes[0] - right.affectedPointIndexes[0];
  });

  const deduped: RouteCleanupIssue[] = [];
  for (const issue of ordered) {
    if (
      deduped.some(
        (existing) =>
          existing.type === issue.type &&
          rangesSubstantiallyOverlap(existing.affectedPointIndexes, issue.affectedPointIndexes)
      )
    ) {
      continue;
    }

    deduped.push(issue);
  }

  return deduped.sort((left, right) => left.affectedPointIndexes[0] - right.affectedPointIndexes[0]);
};

const mergePersistedStatuses = (
  detectedIssues: RouteCleanupIssue[],
  persistedIssues: RouteCleanupIssue[] | undefined,
  fallbackSource: RouteCleanupSuggestionSource
): RouteCleanupIssue[] => {
  const persistedMap = new Map((persistedIssues ?? []).map((issue) => [issue.id, issue]));
  const detectedIds = new Set(detectedIssues.map((issue) => issue.id));
  const merged = detectedIssues.map((issue) => {
    const persisted = persistedMap.get(issue.id);
    if (!persisted) {
      return issue;
    }

    return {
      ...issue,
      status: persisted.status,
      source: persisted.source ?? fallbackSource,
      proposedGeometry: persisted.proposedGeometry ?? issue.proposedGeometry,
    };
  });

  for (const persisted of persistedIssues ?? []) {
    if (detectedIds.has(persisted.id) || persisted.status === 'pending') {
      continue;
    }
    merged.push({
      ...persisted,
      source: persisted.source ?? fallbackSource,
    });
  }

  return merged;
};

export const analyzeRouteCleanupIssues = (
  points: RouteCleanupPoint[],
  source: RouteCleanupSuggestionSource = 'editor'
): RouteCleanupIssue[] => {
  if (points.length < 5) {
    return [];
  }

  return dedupeIssues([
    ...detectCircularJitterIssues(points, source),
    ...detectDuplicateOverlapIssues(points, source),
  ]);
};

export const buildRouteCleanupMetadata = (
  points: RouteCleanupPoint[],
  options: RouteCleanupAnalysisOptions = {}
): RouteCleanupMetadata | null => {
  const source = options.source ?? 'editor';
  const detectedIssues = analyzeRouteCleanupIssues(points, source);
  const issues = mergePersistedStatuses(detectedIssues, options.persistedIssues, source);

  if (!options.originalGeometry && issues.length === 0) {
    return null;
  }

  return {
    source,
    originalGeometry: options.originalGeometry ?? null,
    proposedGeometry: issues.length === 1 ? issues[0].proposedGeometry : null,
    issues,
    updatedAt: new Date().toISOString(),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const asLineString = (value: unknown): LineString | null => {
  if (!isRecord(value) || value.type !== 'LineString' || !Array.isArray(value.coordinates)) {
    return null;
  }

  return value as unknown as LineString;
};

const parseIssueStatus = (value: unknown): RouteCleanupIssueStatus => {
  if (value === 'accepted' || value === 'dismissed') {
    return value;
  }
  return 'pending';
};

export const readRouteCleanupMetadata = (value: unknown): RouteCleanupMetadata | null => {
  if (!isRecord(value)) {
    return null;
  }

  const rawCleanup = isRecord(value.geometryCleanup) ? value.geometryCleanup : value;
  if (!isRecord(rawCleanup)) {
    return null;
  }

  const source: RouteCleanupSuggestionSource = rawCleanup.source === 'worker' ? 'worker' : 'editor';
  const issues = Array.isArray(rawCleanup.issues)
    ? rawCleanup.issues
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }

          const proposedGeometry = asLineString(entry.proposedGeometry);

          if (
            !proposedGeometry ||
            proposedGeometry.type !== 'LineString' ||
            !Array.isArray(proposedGeometry.coordinates)
          ) {
            return null;
          }

          const affectedPointIndexes = Array.isArray(entry.affectedPointIndexes)
            ? [
                Math.max(0, Number(entry.affectedPointIndexes[0]) || 0),
                Math.max(0, Number(entry.affectedPointIndexes[1]) || 0),
              ]
            : [0, 0];

          return {
            id: typeof entry.id === 'string' ? entry.id : `cleanup:${Math.random().toString(36).slice(2)}`,
            type: entry.type === 'duplicate_overlap' ? 'duplicate_overlap' : 'circular_jitter',
            title: typeof entry.title === 'string' ? entry.title : 'Cleanup suggestion',
            message: typeof entry.message === 'string' ? entry.message : '',
            confidence: clamp(Number(entry.confidence) || 0, 0, 0.99),
            source: entry.source === 'worker' ? 'worker' : source,
            status: parseIssueStatus(entry.status),
            affectedPointIndexes: affectedPointIndexes as [number, number],
            metrics: isRecord(entry.metrics)
              ? (Object.fromEntries(
                  Object.entries(entry.metrics)
                    .filter(([, metricValue]) => typeof metricValue === 'number' && Number.isFinite(metricValue))
                    .map(([metricKey, metricValue]) => [metricKey, metricValue as number])
                ) as Record<string, number>)
              : {},
            proposedGeometry,
          } satisfies RouteCleanupIssue;
        })
        .filter((issue): issue is RouteCleanupIssue => Boolean(issue))
    : [];

  const originalGeometry = asLineString(rawCleanup.originalGeometry);
  const proposedGeometry = asLineString(rawCleanup.proposedGeometry);

  if (!originalGeometry && !proposedGeometry && issues.length === 0) {
    return null;
  }

  return {
    source,
    originalGeometry,
    proposedGeometry,
    issues,
    updatedAt: typeof rawCleanup.updatedAt === 'string' ? rawCleanup.updatedAt : new Date().toISOString(),
  };
};

export const upsertRouteCleanupIssue = (
  issues: RouteCleanupIssue[],
  issue: RouteCleanupIssue,
  status: RouteCleanupIssueStatus
): RouteCleanupIssue[] => {
  const nextIssue: RouteCleanupIssue = {
    ...issue,
    status,
  };
  const existingIndex = issues.findIndex((entry) => entry.id === issue.id);
  if (existingIndex >= 0) {
    const nextIssues = [...issues];
    nextIssues[existingIndex] = nextIssue;
    return nextIssues;
  }

  return [...issues, nextIssue];
};
