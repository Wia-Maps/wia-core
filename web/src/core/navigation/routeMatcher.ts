import type { RoutePreview } from '../../store/useAppStore';
import { bearingBetween, clamp, haversineMeters, shortestHeadingDelta } from './geo';
import type { NavigationPose, RouteMatch } from './types';

interface SegmentCandidate {
  segmentIndex: number;
  snappedPoint: [number, number];
  distanceM: number;
  progressDistanceM: number;
  remainingDistanceM: number;
  headingDeltaDeg: number;
  routeBearingDeg: number;
  emissionScore: number;
  transitionScore: number;
  score: number;
}

interface SegmentProjection {
  point: [number, number];
  t: number;
  distanceM: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const projectToSegment = (
  point: [number, number],
  segmentStart: [number, number],
  segmentEnd: [number, number]
): SegmentProjection => {
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
  const t = lengthSq > 0 ? clamp(((px - ax) * abx + (py - ay) * aby) / lengthSq, 0, 1) : 0;
  const projX = ax + abx * t;
  const projY = ay + aby * t;

  return {
    point: [projY / latFactor, projX / lngFactor],
    t,
    distanceM: Math.hypot(px - projX, py - projY),
  };
};

const pathLengths = (path: [number, number][]): { lengths: number[]; cumulative: number[]; total: number } => {
  const lengths: number[] = [];
  const cumulative = [0];
  let total = 0;

  for (let index = 1; index < path.length; index += 1) {
    const length = haversineMeters(path[index - 1], path[index]);
    lengths.push(length);
    total += length;
    cumulative.push(total);
  }

  return { lengths, cumulative, total };
};

export const matchPoseToRoute = (
  pose: NavigationPose,
  route: RoutePreview,
  previousMatch: RouteMatch | null
): RouteMatch | null => {
  const path = route.path;
  if (path.length < 2) {
    return null;
  }

  const { lengths, cumulative, total } = pathLengths(path);
  const candidates: SegmentCandidate[] = [];
  const searchRadiusM = clamp(pose.accuracyM * 1.5, 12, 80);

  for (let index = 0; index < path.length - 1; index += 1) {
    const projection = projectToSegment(pose.position, path[index], path[index + 1]);
    if (projection.distanceM > searchRadiusM && candidates.length >= 12) {
      continue;
    }

    const segmentLength = lengths[index] ?? 0;
    const progressDistanceM = cumulative[index] + segmentLength * projection.t;
    const routeBearingDeg = bearingBetween(path[index], path[index + 1]);
    const headingDeltaDeg = Math.abs(shortestHeadingDelta(pose.headingDeg, routeBearingDeg));
    const distanceSigma = clamp(pose.accuracyM, 4, 60);
    const distanceScore = Math.exp(-(projection.distanceM * projection.distanceM) / (2 * distanceSigma * distanceSigma));
    const headingScore = pose.speedMps < 0.45 ? 0.75 : Math.exp(-headingDeltaDeg / 75);
    const routeContinuityScore = previousMatch
      ? Math.exp(-Math.abs(progressDistanceM - previousMatch.progressDistanceM) / 70)
      : 1;
    const emissionScore = distanceScore * headingScore;
    const transitionScore = routeContinuityScore;

    candidates.push({
      segmentIndex: index,
      snappedPoint: projection.point,
      distanceM: projection.distanceM,
      progressDistanceM,
      remainingDistanceM: Math.max(0, total - progressDistanceM),
      headingDeltaDeg,
      routeBearingDeg,
      emissionScore,
      transitionScore,
      score: emissionScore * transitionScore,
    });
  }

  const best = candidates
    .sort((left, right) => right.score - left.score || left.distanceM - right.distanceM)
    .slice(0, 12)[0];

  if (!best) {
    return null;
  }

  const confidence = clamp(best.score * (best.distanceM <= searchRadiusM ? 1 : 0.45), 0, 1);

  return {
    edgeId: route.graph_node_ids?.[best.segmentIndex] ?? null,
    segmentIndex: best.segmentIndex,
    snappedPoint: best.snappedPoint,
    distanceFromRouteM: best.distanceM,
    progressDistanceM: best.progressDistanceM,
    remainingDistanceM: best.remainingDistanceM,
    headingDeltaDeg: best.headingDeltaDeg,
    confidence,
  };
};
