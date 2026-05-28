import type { Feature, FeatureCollection, Geometry, LineString } from 'geojson';
import type {
  RouteAccessibilityMode,
  RouteEtaMode,
  RoutePreview,
  RouteStep,
  UserMotion,
} from '../store/useAppStore';
import type { CampusRoutingGraph, RoutingGraphEdge, RoutingGraphNode } from './routingGraph';
import {
  collectFeatureBoundarySamplePoints,
  collectBlockingStructureFeatures,
  featureBoundaryDistanceToPointMeters,
  featureBoundaryPointNearestToPoint,
  featureContainsPoint,
  featureDistanceToPointMeters,
  isBoundaryFeature,
  isOpenAreaFeature,
  resolveFeatureId,
  resolveRoutingAccessMode,
  segmentCrossesBlockingStructures,
} from './geoGeometry';

interface SegmentProjection {
  point: [number, number];
  t: number;
  distanceM: number;
}

interface EdgeProjection extends SegmentProjection {
  edge: RoutingGraphEdge;
  segmentIndex: number;
}

interface PathTraversal {
  edge: RoutingGraphEdge;
  reverse: boolean;
}

interface DijkstraResult {
  choiceCostM: number;
  distanceM: number;
  etaCostM: number;
  syntheticSegmentCount: number;
  traversals: PathTraversal[];
  nodeIds: string[];
}

export interface DijkstraRouteOutput {
  node_ids: string[];
  total_distance_m: number;
  line: Feature<LineString>;
}

export interface RouteTrackingInfo {
  snapped_point: [number, number];
  off_route_distance_m: number;
  remaining_path: [number, number][];
  remaining_distance_m: number;
  progress_distance_m: number;
  current_step_index: number;
  distance_to_next_turn_m: number;
}

export interface BuildCampusRoutePreviewOptions {
  origin: [number, number];
  originLocationId?: string | null;
  destination: [number, number];
  destinationId: string;
  graph: CampusRoutingGraph | null;
  accessibilityMode: RouteAccessibilityMode;
  locations?: FeatureCollection<Geometry, Record<string, unknown>> | null;
  projectionIndex?: RoutingProjectionIndex | null;
}

interface IndexedEdgeSegment {
  edgeId: string;
  segmentIndex: number;
}

export interface RoutingProjectionIndex {
  cellSizeM: number;
  referenceLat: number;
  latFactor: number;
  lngFactor: number;
  cells: Map<string, IndexedEdgeSegment[]>;
}

interface RouteStartCandidate {
  nodeId: string;
  selectionPenaltyM: number;
  pathPrefix: [number, number][];
  snappedOrigin: [number, number];
  offRouteDistanceM: number;
  originAccessPoint?: [number, number] | null;
  originAccessHintPath?: [number, number][] | null;
  warningMessage?: string;
}

interface RouteDestinationCandidate {
  nodeId: string;
  pathSuffix: [number, number][];
  selectionPenaltyM: number;
  destinationAccessPoint?: [number, number] | null;
  warningMessage?: string;
}

interface ResolvedDestinationCandidates {
  candidateGroups: RouteDestinationCandidate[][];
  warningMessage?: string;
}

interface RequiredGateGroup {
  compoundId: string;
  nodeIds: string[];
}

interface PriorityQueueEntry {
  nodeId: string;
  estimatedChoiceCostM: number;
  metrics: RouteCostMetrics;
}

interface ReverseRoutingAdjacency {
  nodeId: string;
  traversal: PathTraversal;
}

const EARTH_RADIUS_M = 6371000;
export const WALKING_METERS_PER_MINUTE = 81;
const DESTINATION_CANDIDATE_COUNT = 3;
const DESTINATION_NEARBY_NODE_MAX_DISTANCE_M = 35;
const OPEN_AREA_BOUNDARY_MAX_DISTANCE_M = 60;
const ENCLOSED_BOUNDARY_MAX_DISTANCE_M = 60;
const ORIGIN_EDGE_CANDIDATE_COUNT = 8;
const MAX_ROUTE_START_CANDIDATES = 6;
const MAX_ROUTE_DESTINATION_CANDIDATES = 6;
const ORIGIN_EDGE_MAX_DISTANCE_M = 50;
const ENTRANCE_EDGE_MAX_DISTANCE_M = 90;
const PROJECTION_INDEX_CELL_SIZE_M = 36;
const ORIGIN_LOCATION_FALLBACK_DISTANCE_M = 18;
const NAV_STEP_TURN_THRESHOLD_DEG = 38;
const NAV_STEP_STRAIGHT_THRESHOLD_DEG = 18;
const NAV_STEP_MIN_DISTANCE_M = 14;
const NAV_STEP_SHORT_FINAL_DISTANCE_M = 8;
const NAV_STEP_SHARP_TURN_THRESHOLD_DEG = 105;
const NAV_STEP_UTURN_THRESHOLD_DEG = 155;
const LIVE_ETA_MOVEMENT_THRESHOLD_MPS = 0.45;
const LIVE_ETA_GPS_ACCURACY_MAX_M = 35;
const LIVE_ETA_GPS_SPEED_MIN_MPS = 0.2;
const LIVE_ETA_GPS_SPEED_MAX_MPS = 2.6;
const LIVE_ETA_INFERRED_SPEED_MIN_MPS = 0.2;
const LIVE_ETA_INFERRED_SPEED_MAX_MPS = 2.3;
const LIVE_ETA_SPEED_SAMPLE_WINDOW = 5;
const LIVE_ETA_PROGRESS_WINDOW_MS = 6000;
const LIVE_ETA_PROGRESS_START_DISTANCE_M = 4;
const LIVE_ETA_START_SAMPLE_COUNT = 3;
const LIVE_ETA_PAUSE_HOLD_MS = 8000;

type BlockingStructureFeature = Feature<Geometry, Record<string, unknown>>;
type LocationFeature = Feature<Geometry, Record<string, unknown>>;

interface ProgressSample {
  timestampMs: number;
  progressDistanceM: number;
}

export interface MotionEtaRuntimeState {
  routeSignature: string | null;
  progressSamples: ProgressSample[];
  speedSamplesMps: number[];
  movingSampleStreak: number;
  movementQualified: boolean;
  pauseStartedAtMs: number | null;
  pauseEtaAnchorMin: number | null;
  lastEtaMin: number | null;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

const haversineMeters = (from: [number, number], to: [number, number]): number => {
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;

  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const bearingBetween = (from: [number, number], to: [number, number]): number => {
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;

  const phi1 = toRadians(fromLat);
  const phi2 = toRadians(toLat);
  const deltaLambda = toRadians(toLng - fromLng);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const raw = toDegrees(Math.atan2(y, x));
  return (raw + 360) % 360;
};

const bearingToCardinal = (bearing: number): string => {
  const directions = [
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
  ];
  const index = Math.round(bearing / 45) % directions.length;
  return directions[index];
};

const formatDistance = (distanceMeters: number): string => {
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(1)} km`;
  }

  return `${Math.max(1, Math.round(distanceMeters))} m`;
};

const bearingDeltaDegrees = (left: number, right: number): number => {
  let delta = right - left;
  while (delta > 180) {
    delta -= 360;
  }
  while (delta < -180) {
    delta += 360;
  }

  return delta;
};

const nearlySamePoint = (left: [number, number], right: [number, number]): boolean => {
  return Math.abs(left[0] - right[0]) < 0.0000005 && Math.abs(left[1] - right[1]) < 0.0000005;
};

const appendPath = (target: [number, number][], points: [number, number][]): void => {
  points.forEach((point) => {
    if (target.length === 0 || !nearlySamePoint(target[target.length - 1], point)) {
      target.push(point);
    }
  });
};

const toMapPoint = (point: [number, number]): [number, number] => {
  return [point[1], point[0]];
};

const fromMapPoint = (point: [number, number]): [number, number] => {
  return [point[1], point[0]];
};

const pathCrossesBlockingStructures = (
  path: [number, number][],
  blockingStructureFeatures: BlockingStructureFeature[],
  options?: {
    allowedLocationIds?: Iterable<string> | null;
  }
): boolean => {
  if (blockingStructureFeatures.length === 0) {
    return false;
  }

  for (let index = 0; index < path.length - 1; index += 1) {
    if (
      segmentCrossesBlockingStructures(
        toMapPoint(path[index]),
        toMapPoint(path[index + 1]),
        blockingStructureFeatures,
        options
      )
    ) {
      return true;
    }
  }

  return false;
};

const routeDistanceMeters = (path: [number, number][]): number => {
  let totalDistance = 0;

  for (let index = 1; index < path.length; index += 1) {
    totalDistance += haversineMeters(path[index - 1], path[index]);
  }

  return Math.max(1, Math.round(totalDistance));
};

const pathToGeoJsonLine = (path: [number, number][]): Feature<LineString> => {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: path.map(([lat, lng]) => [lng, lat]),
    },
  };
};
interface RawRouteSegment {
  distanceM: number;
  bearing: number;
  startDistanceM: number;
  endDistanceM: number;
}

interface NavigationStepDraft {
  turnDelta: number | null;
  bearing: number;
  distanceM: number;
  startDistanceM: number;
  endDistanceM: number;
}

const shouldStartNewNavigationStep = (
  currentStep: NavigationStepDraft,
  nextSegment: RawRouteSegment,
  isFinalSegment: boolean
): boolean => {
  const delta = bearingDeltaDegrees(currentStep.bearing, nextSegment.bearing);
  const absDelta = Math.abs(delta);

  if (absDelta < NAV_STEP_STRAIGHT_THRESHOLD_DEG) {
    return false;
  }

  if (absDelta >= NAV_STEP_TURN_THRESHOLD_DEG) {
    return (
      currentStep.distanceM >= NAV_STEP_MIN_DISTANCE_M ||
      isFinalSegment ||
      nextSegment.distanceM >= NAV_STEP_MIN_DISTANCE_M
    );
  }

  return currentStep.distanceM >= NAV_STEP_MIN_DISTANCE_M * 2 && nextSegment.distanceM >= NAV_STEP_MIN_DISTANCE_M;
};

const buildStepInstruction = (step: NavigationStepDraft, index: number): string => {
  const distance = formatDistance(step.distanceM);

  if (index === 0 || step.turnDelta === null) {
    return `Head ${bearingToCardinal(step.bearing)} for ${distance}`;
  }

  const absTurnDelta = Math.abs(step.turnDelta);
  if (absTurnDelta < NAV_STEP_STRAIGHT_THRESHOLD_DEG) {
    return `Continue for ${distance}`;
  }

  const side = step.turnDelta > 0 ? 'right' : 'left';

  if (absTurnDelta >= NAV_STEP_UTURN_THRESHOLD_DEG) {
    return `Make a U-turn and continue for ${distance}`;
  }

  if (absTurnDelta >= NAV_STEP_SHARP_TURN_THRESHOLD_DEG) {
    return `Make a sharp ${side} and continue for ${distance}`;
  }

  if (absTurnDelta < NAV_STEP_TURN_THRESHOLD_DEG) {
    return `Bear ${side} and continue for ${distance}`;
  }

  return `Turn ${side} and continue for ${distance}`;
};

const buildSteps = (path: [number, number][]): RouteStep[] => {
  const rawSegments: RawRouteSegment[] = [];
  let cumulativeDistanceM = 0;

  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    const distanceM = haversineMeters(from, to);
    if (distanceM <= 0.25) {
      continue;
    }

    const startDistanceM = cumulativeDistanceM;
    cumulativeDistanceM += distanceM;
    rawSegments.push({
      distanceM,
      bearing: bearingBetween(from, to),
      startDistanceM,
      endDistanceM: cumulativeDistanceM,
    });
  }

  const drafts: NavigationStepDraft[] = [];

  rawSegments.forEach((segment, index) => {
    const currentStep = drafts[drafts.length - 1];
    const isFinalSegment = index === rawSegments.length - 1;

    if (!currentStep) {
      drafts.push({
        turnDelta: null,
        bearing: segment.bearing,
        distanceM: segment.distanceM,
        startDistanceM: segment.startDistanceM,
        endDistanceM: segment.endDistanceM,
      });
      return;
    }

    if (!shouldStartNewNavigationStep(currentStep, segment, isFinalSegment)) {
      currentStep.distanceM += segment.distanceM;
      currentStep.endDistanceM = segment.endDistanceM;
      if (Math.abs(bearingDeltaDegrees(currentStep.bearing, segment.bearing)) >= NAV_STEP_STRAIGHT_THRESHOLD_DEG) {
        currentStep.bearing = segment.bearing;
      }
      return;
    }

    drafts.push({
      turnDelta: bearingDeltaDegrees(currentStep.bearing, segment.bearing),
      bearing: segment.bearing,
      distanceM: segment.distanceM,
      startDistanceM: segment.startDistanceM,
      endDistanceM: segment.endDistanceM,
    });
  });

  if (drafts.length > 1) {
    const finalStep = drafts[drafts.length - 1];
    const previousStep = drafts[drafts.length - 2];
    if (
      finalStep.distanceM < NAV_STEP_SHORT_FINAL_DISTANCE_M &&
      Math.abs(finalStep.turnDelta ?? 0) < NAV_STEP_TURN_THRESHOLD_DEG
    ) {
      previousStep.distanceM += finalStep.distanceM;
      previousStep.endDistanceM = finalStep.endDistanceM;
      drafts.pop();
    }
  }

  return drafts.map((step, index) => ({
    id: `step_${index + 1}`,
    instruction: buildStepInstruction(step, index),
    distance_m: Math.max(1, Math.round(step.distanceM)),
    start_distance_m: Math.max(0, Math.round(step.startDistanceM)),
    end_distance_m: Math.max(1, Math.round(step.endDistanceM)),
  }));
};

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

  const projected: [number, number] = [projY / latFactor, projX / lngFactor];
  const dx = px - projX;
  const dy = py - projY;

  return {
    point: projected,
    t: clampedT,
    distanceM: Math.sqrt(dx * dx + dy * dy),
  };
};

const segmentLengths = (path: [number, number][]): number[] => {
  const lengths: number[] = [];

  for (let index = 0; index < path.length - 1; index += 1) {
    lengths.push(haversineMeters(path[index], path[index + 1]));
  }

  return lengths;
};

const cumulativeLengths = (lengths: number[]): number[] => {
  const cumulative = [0];
  lengths.forEach((length) => {
    cumulative.push(cumulative[cumulative.length - 1] + length);
  });
  return cumulative;
};

const buildRemainingPath = (
  path: [number, number][],
  segmentIndex: number,
  snappedPoint: [number, number]
): [number, number][] => {
  const nextVertexIndex = Math.min(segmentIndex + 1, path.length - 1);
  const tail = path.slice(nextVertexIndex);

  const remaining: [number, number][] = [snappedPoint];

  tail.forEach((point) => {
    const previous = remaining[remaining.length - 1];
    if (!nearlySamePoint(previous, point)) {
      remaining.push(point);
    }
  });

  if (remaining.length === 1 && path.length > 1) {
    const destination = path[path.length - 1];
    if (!nearlySamePoint(remaining[0], destination)) {
      remaining.push(destination);
    }
  }

  return remaining;
};

const buildDisplayAnchoredRemainingPath = (
  location: [number, number],
  snappedPoint: [number, number],
  remainingPath: [number, number][],
  offRouteDistanceM: number
): [number, number][] => {
  const anchored: [number, number][] = [location];

  if (offRouteDistanceM > 1.5 && !nearlySamePoint(location, snappedPoint)) {
    anchored.push(snappedPoint);
  }

  remainingPath.forEach((point) => {
    const previous = anchored[anchored.length - 1];
    if (!nearlySamePoint(previous, point)) {
      anchored.push(point);
    }
  });

  return anchored;
};

const edgeAllowed = (edge: RoutingGraphEdge, mode: RouteAccessibilityMode): boolean => {
  if (mode !== 'accessible') {
    return true;
  }

  // MVP accessibility profile:
  // - avoid explicit stairs-only links
  // - require accessibility flag
  return edge.accessible && !edge.stairs;
};

const edgeUsableForRouting = (
  edge: RoutingGraphEdge,
  mode: RouteAccessibilityMode,
  blockedEdgeIds?: ReadonlySet<string>
): boolean => {
  return edgeAllowed(edge, mode) && !blockedEdgeIds?.has(edge.id);
};

interface RouteCostMetrics {
  choiceCostM: number;
  distanceM: number;
  etaCostM: number;
  syntheticSegmentCount: number;
}

const ZERO_ROUTE_COST_METRICS: RouteCostMetrics = {
  choiceCostM: 0,
  distanceM: 0,
  etaCostM: 0,
  syntheticSegmentCount: 0,
};

const isSyntheticRoutingEdge = (edge: RoutingGraphEdge): boolean => {
  return edge.sourceKind === 'synthetic_bridge' || edge.sourceKind === 'synthetic_connector';
};

const edgeOverlayPenaltyM = (edge: RoutingGraphEdge): number => {
  const overlayExtraM = Math.max(0, edge.weight_m - edge.distance_m);
  return Math.min(overlayExtraM, edge.distance_m * 0.15);
};

const edgeRouteCostMetrics = (edge: RoutingGraphEdge): RouteCostMetrics => {
  return {
    choiceCostM: edge.distance_m + edgeOverlayPenaltyM(edge),
    distanceM: edge.distance_m,
    etaCostM: edge.weight_m,
    syntheticSegmentCount: isSyntheticRoutingEdge(edge) ? 1 : 0,
  };
};

const addRouteCostMetrics = (
  left: RouteCostMetrics,
  right: RouteCostMetrics
): RouteCostMetrics => {
  return {
    choiceCostM: left.choiceCostM + right.choiceCostM,
    distanceM: left.distanceM + right.distanceM,
    etaCostM: left.etaCostM + right.etaCostM,
    syntheticSegmentCount: left.syntheticSegmentCount + right.syntheticSegmentCount,
  };
};

const compareRouteCostMetrics = (
  left: RouteCostMetrics,
  right: RouteCostMetrics
): number => {
  if (left.choiceCostM !== right.choiceCostM) {
    return left.choiceCostM - right.choiceCostM;
  }

  if (left.distanceM !== right.distanceM) {
    return left.distanceM - right.distanceM;
  }

  if (left.syntheticSegmentCount !== right.syntheticSegmentCount) {
    return left.syntheticSegmentCount - right.syntheticSegmentCount;
  }

  return left.etaCostM - right.etaCostM;
};

const etaMinutesFromEquivalentDistance = (distanceEquivalentM: number): number => {
  return Math.max(1, Math.round(distanceEquivalentM / WALKING_METERS_PER_MINUTE));
};

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const averageNumbers = (values: number[]): number | null => {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
};

const buildRouteSignature = (preview: RoutePreview): string => {
  return [
    preview.destination_id,
    preview.routing_mode ?? 'standard',
    preview.graph_node_ids?.join('>') ?? `path_${preview.path.length}`,
    preview.distance_m,
  ].join('|');
};

const baselineEtaMinutes = (preview: RoutePreview): number => {
  return preview.eta_baseline_min ?? preview.eta_min;
};

const baselineRemainingEtaMinutes = (
  preview: RoutePreview,
  remainingDistanceM: number
): number => {
  if (preview.distance_m <= 0) {
    return 0;
  }

  return Math.max(
    0,
    Math.round((baselineEtaMinutes(preview) * remainingDistanceM) / Math.max(1, preview.distance_m))
  );
};

const gpsSpeedAcceptedForEta = (
  speedMps: number | null | undefined,
  accuracyM: number | null | undefined
): number | null => {
  if (
    typeof speedMps !== 'number' ||
    !Number.isFinite(speedMps) ||
    typeof accuracyM !== 'number' ||
    !Number.isFinite(accuracyM) ||
    accuracyM > LIVE_ETA_GPS_ACCURACY_MAX_M
  ) {
    return null;
  }

  if (speedMps < LIVE_ETA_GPS_SPEED_MIN_MPS || speedMps > LIVE_ETA_GPS_SPEED_MAX_MPS) {
    return null;
  }

  return speedMps;
};

const inferredSpeedFromProgressSamples = (
  progressSamples: ProgressSample[]
): number | null => {
  if (progressSamples.length < 2) {
    return null;
  }

  const earliest = progressSamples[0];
  const latest = progressSamples[progressSamples.length - 1];
  const elapsedMs = latest.timestampMs - earliest.timestampMs;
  const progressGainM = latest.progressDistanceM - earliest.progressDistanceM;

  if (elapsedMs < 1000 || progressGainM <= 0.5) {
    return null;
  }

  return clampNumber(
    progressGainM / (elapsedMs / 1000),
    LIVE_ETA_INFERRED_SPEED_MIN_MPS,
    LIVE_ETA_INFERRED_SPEED_MAX_MPS
  );
};

const progressGainInWindow = (progressSamples: ProgressSample[]): number => {
  if (progressSamples.length === 0) {
    return 0;
  }

  const latest = progressSamples[progressSamples.length - 1];
  const minimumProgress = progressSamples.reduce(
    (best, sample) => Math.min(best, sample.progressDistanceM),
    latest.progressDistanceM
  );

  return Math.max(0, latest.progressDistanceM - minimumProgress);
};

const etaMinutesFromSpeed = (
  remainingDistanceM: number,
  speedMps: number
): number => {
  if (!Number.isFinite(speedMps) || speedMps <= 0) {
    return 0;
  }

  return Math.max(0, Math.round(remainingDistanceM / speedMps / 60));
};

export const createMotionEtaRuntimeState = (): MotionEtaRuntimeState => {
  return {
    routeSignature: null,
    progressSamples: [],
    speedSamplesMps: [],
    movingSampleStreak: 0,
    movementQualified: false,
    pauseStartedAtMs: null,
    pauseEtaAnchorMin: null,
    lastEtaMin: null,
  };
};

const collectBlockedSyntheticEdgeIds = (
  graph: CampusRoutingGraph,
  blockingStructureFeatures: BlockingStructureFeature[]
): Set<string> => {
  if (blockingStructureFeatures.length === 0) {
    return new Set<string>();
  }

  return new Set(
    graph.edges
      .filter((edge) => edge.sourceKind === 'synthetic_bridge' || edge.sourceKind === 'synthetic_connector')
      .filter((edge) => pathCrossesBlockingStructures(edge.coordinates, blockingStructureFeatures))
      .map((edge) => edge.id)
  );
};

const nodeHasGraphConnection = (graph: CampusRoutingGraph, nodeId: string): boolean => {
  return (graph.adjacency.get(nodeId)?.length ?? 0) > 0;
};

const nearestNodeEntries = (
  graph: CampusRoutingGraph,
  point: [number, number],
  count: number,
  options?: {
    connectedOnly?: boolean;
    maxDistanceM?: number;
  }
): Array<{ id: string; distance: number }> => {
  const connectedOnly = options?.connectedOnly ?? false;
  const maxDistanceM = options?.maxDistanceM ?? Number.POSITIVE_INFINITY;

  return Array.from(graph.nodes.values())
    .filter((node) => !connectedOnly || nodeHasGraphConnection(graph, node.id))
    .map((node) => ({
      id: node.id,
      distance: haversineMeters(point, node.coordinates),
    }))
    .filter((entry) => entry.distance <= maxDistanceM)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, count);
};

const dedupeDestinationCandidates = (
  candidates: RouteDestinationCandidate[]
): RouteDestinationCandidate[] => {
  const deduped = new Map<string, RouteDestinationCandidate>();

  candidates.forEach((candidate) => {
    const existing = deduped.get(candidate.nodeId);
    if (!existing || candidate.selectionPenaltyM < existing.selectionPenaltyM) {
      deduped.set(candidate.nodeId, candidate);
    }
  });

  return Array.from(deduped.values()).sort((left, right) => left.selectionPenaltyM - right.selectionPenaltyM);
};

const findLocationFeatureById = (
  locations: FeatureCollection<Geometry, Record<string, unknown>> | null | undefined,
  locationId: string
): LocationFeature | null => {
  if (!locations?.features?.length) {
    return null;
  }

  return (
    locations.features.find(
      (feature, index): feature is LocationFeature => resolveFeatureId(feature, index) === locationId
    ) ?? null
  );
};

const buildArrivedRoutePreview = (
  origin: [number, number],
  destinationId: string,
  accessibilityMode: RouteAccessibilityMode,
  warningMessage?: string
): RoutePreview => {
  const path: [number, number][] = [origin, origin];

  return {
    destination_id: destinationId,
    mode: 'walking',
    path,
    route_kind: 'graph',
    fallback_reason: null,
    distance_m: 0,
    eta_min: 0,
    eta_cost_m: 0,
    eta_baseline_min: 0,
    eta_live_min: 0,
    eta_mode: 'planned',
    steps: [],
    graph_node_ids: [],
    path_geojson: pathToGeoJsonLine(path),
    snapped_origin: origin,
    remaining_path: path,
    remaining_distance_m: 0,
    eta_smoothed_min: 0,
    current_step_index: 0,
    distance_to_next_turn_m: 0,
    off_route_distance_m: 0,
    routing_mode: accessibilityMode,
    origin_access_point: origin,
    destination_access_point: origin,
    origin_access_hint_path: null,
    warning_message: warningMessage,
  };
};

const buildOpenAreaAccessPlan = (
  destinationFeature: LocationFeature,
  point: [number, number]
): {
  endpoint: [number, number];
  selectionPenaltyM: number;
} | null => {
  if (featureContainsPoint(destinationFeature, toMapPoint(point))) {
    return {
      endpoint: point,
      selectionPenaltyM: 0,
    };
  }

  const boundaryPoint = featureBoundaryPointNearestToPoint(destinationFeature, toMapPoint(point));
  if (!boundaryPoint) {
    return null;
  }

  const endpoint = fromMapPoint(boundaryPoint);
  return {
    endpoint,
    selectionPenaltyM: haversineMeters(point, endpoint),
  };
};

const supportsEnclosedBoundaryAccess = (
  feature: LocationFeature | null | undefined
): feature is LocationFeature => {
  if (!feature) {
    return false;
  }

  const geometryType = feature.geometry?.type;
  if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
    return false;
  }

  const accessMode = resolveRoutingAccessMode(feature);
  if (accessMode === 'open_area') {
    return false;
  }

  return !isOpenAreaFeature(feature);
};

const buildEnclosedBoundaryAccessPlan = (
  feature: LocationFeature,
  point: [number, number]
): {
  endpoint: [number, number];
  selectionPenaltyM: number;
} | null => {
  const boundaryPoint = featureBoundaryPointNearestToPoint(feature, toMapPoint(point));
  if (!boundaryPoint) {
    return null;
  }

  const endpoint = fromMapPoint(boundaryPoint);
  return {
    endpoint,
    selectionPenaltyM: haversineMeters(point, endpoint),
  };
};

const buildOpenAreaNodeDestinationCandidates = ({
  graph,
  destinationFeature,
  destinationId,
  blockingStructureFeatures,
}: {
  graph: CampusRoutingGraph;
  destinationFeature: LocationFeature;
  destinationId: string;
  blockingStructureFeatures: BlockingStructureFeature[];
}): RouteDestinationCandidate[] => {
  return dedupeDestinationCandidates(
    Array.from(graph.nodes.values())
      .filter((node) => nodeHasGraphConnection(graph, node.id))
      .flatMap((node) => {
        const isInsideDestination = featureContainsPoint(destinationFeature, toMapPoint(node.coordinates));
        const distanceToBoundaryM = featureBoundaryDistanceToPointMeters(
          destinationFeature,
          toMapPoint(node.coordinates)
        );

        if (!isInsideDestination && distanceToBoundaryM > OPEN_AREA_BOUNDARY_MAX_DISTANCE_M) {
          return [];
        }

        const accessPlan = buildOpenAreaAccessPlan(destinationFeature, node.coordinates);
        if (!accessPlan) {
          return [];
        }

        if (
          pathCrossesBlockingStructures(
            [node.coordinates, accessPlan.endpoint],
            blockingStructureFeatures,
            {
              allowedLocationIds: destinationId ? [destinationId] : null,
            }
          )
        ) {
          return [];
        }

        return [
          {
            nodeId: node.id,
            pathSuffix: [accessPlan.endpoint],
            selectionPenaltyM: accessPlan.selectionPenaltyM,
            destinationAccessPoint: accessPlan.endpoint,
          } satisfies RouteDestinationCandidate,
        ];
      })
  );
};

const buildOpenAreaProjectedDestinationCandidates = ({
  destinationFeature,
  destinationId,
  candidateEdges,
  blockingStructureFeatures,
  projectionIndex,
}: {
  destinationFeature: LocationFeature;
  destinationId: string;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteDestinationCandidate[] => {
  const projectableEdges = candidateEdges.filter((edge) => edge.sourceKind !== 'synthetic_connector');
  const samplePoints = collectFeatureBoundarySamplePoints(destinationFeature);

  return dedupeDestinationCandidates(
    samplePoints.flatMap((samplePoint) => {
        const projections = findClosestEdgeProjections(
          fromMapPoint(samplePoint),
          projectableEdges,
          OPEN_AREA_BOUNDARY_MAX_DISTANCE_M,
          2,
          projectionIndex
        );

      return projections.flatMap((projection) => {
        const accessPlan = buildOpenAreaAccessPlan(destinationFeature, projection.point);
        if (!accessPlan) {
          return [];
        }

        if (
          pathCrossesBlockingStructures(
            [projection.point, accessPlan.endpoint],
            blockingStructureFeatures,
            {
              allowedLocationIds: destinationId ? [destinationId] : null,
            }
          )
        ) {
          return [];
        }

        const fromDistance = distanceAlongEdgeFromStart(projection.edge.coordinates, projection);
        const toDistance = Math.max(0, projection.edge.distance_m - fromDistance);

        const fromSuffix = reversePath(partialEdgePath(projection.edge.coordinates, projection, 'from'));
        appendPath(fromSuffix, [accessPlan.endpoint]);

        const toSuffix = reversePath(partialEdgePath(projection.edge.coordinates, projection, 'to'));
        appendPath(toSuffix, [accessPlan.endpoint]);

        return [
          {
            nodeId: projection.edge.from,
            pathSuffix: fromSuffix,
            selectionPenaltyM: fromDistance + accessPlan.selectionPenaltyM,
            destinationAccessPoint: accessPlan.endpoint,
          } satisfies RouteDestinationCandidate,
          {
            nodeId: projection.edge.to,
            pathSuffix: toSuffix,
            selectionPenaltyM: toDistance + accessPlan.selectionPenaltyM,
            destinationAccessPoint: accessPlan.endpoint,
          } satisfies RouteDestinationCandidate,
        ];
      });
    })
  );
};

const buildOpenAreaDestinationCandidates = ({
  graph,
  destinationFeature,
  destinationId,
  candidateEdges,
  blockingStructureFeatures,
  projectionIndex,
}: {
  graph: CampusRoutingGraph;
  destinationFeature: LocationFeature;
  destinationId: string;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteDestinationCandidate[] => {
  return dedupeDestinationCandidates([
    ...buildOpenAreaNodeDestinationCandidates({
      graph,
      destinationFeature,
      destinationId,
      blockingStructureFeatures,
    }),
    ...buildOpenAreaProjectedDestinationCandidates({
      destinationFeature,
      destinationId,
      candidateEdges,
      blockingStructureFeatures,
      projectionIndex,
    }),
  ]);
};

const buildEnclosedBoundaryNodeDestinationCandidates = ({
  graph,
  destinationFeature,
  destinationId,
  blockingStructureFeatures,
}: {
  graph: CampusRoutingGraph;
  destinationFeature: LocationFeature;
  destinationId: string;
  blockingStructureFeatures: BlockingStructureFeature[];
}): RouteDestinationCandidate[] => {
  return dedupeDestinationCandidates(
    Array.from(graph.nodes.values())
      .filter((node) => nodeHasGraphConnection(graph, node.id))
      .flatMap((node) => {
        const distanceToBoundaryM = featureBoundaryDistanceToPointMeters(
          destinationFeature,
          toMapPoint(node.coordinates)
        );

        if (!Number.isFinite(distanceToBoundaryM) || distanceToBoundaryM > ENCLOSED_BOUNDARY_MAX_DISTANCE_M) {
          return [];
        }

        const accessPlan = buildEnclosedBoundaryAccessPlan(destinationFeature, node.coordinates);
        if (!accessPlan) {
          return [];
        }

        if (
          pathCrossesBlockingStructures(
            [node.coordinates, accessPlan.endpoint],
            blockingStructureFeatures,
            {
              allowedLocationIds: destinationId ? [destinationId] : null,
            }
          )
        ) {
          return [];
        }

        return [
          {
            nodeId: node.id,
            pathSuffix: [accessPlan.endpoint],
            selectionPenaltyM: accessPlan.selectionPenaltyM,
            destinationAccessPoint: accessPlan.endpoint,
            warningMessage: 'Using building boundary access fallback near destination.',
          } satisfies RouteDestinationCandidate,
        ];
      })
  );
};

const buildEnclosedBoundaryProjectedDestinationCandidates = ({
  destinationFeature,
  destinationId,
  candidateEdges,
  blockingStructureFeatures,
  projectionIndex,
}: {
  destinationFeature: LocationFeature;
  destinationId: string;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteDestinationCandidate[] => {
  const projectableEdges = candidateEdges.filter((edge) => edge.sourceKind !== 'synthetic_connector');
  const samplePoints = collectFeatureBoundarySamplePoints(destinationFeature);

  return dedupeDestinationCandidates(
    samplePoints.flatMap((samplePoint) => {
      const projections = findClosestEdgeProjections(
        fromMapPoint(samplePoint),
        projectableEdges,
        ENCLOSED_BOUNDARY_MAX_DISTANCE_M,
        2,
        projectionIndex
      );

      return projections.flatMap((projection) => {
        const accessPlan = buildEnclosedBoundaryAccessPlan(destinationFeature, projection.point);
        if (!accessPlan) {
          return [];
        }

        if (
          pathCrossesBlockingStructures(
            [projection.point, accessPlan.endpoint],
            blockingStructureFeatures,
            {
              allowedLocationIds: destinationId ? [destinationId] : null,
            }
          )
        ) {
          return [];
        }

        const fromDistance = distanceAlongEdgeFromStart(projection.edge.coordinates, projection);
        const toDistance = Math.max(0, projection.edge.distance_m - fromDistance);

        const fromSuffix = reversePath(partialEdgePath(projection.edge.coordinates, projection, 'from'));
        appendPath(fromSuffix, [accessPlan.endpoint]);

        const toSuffix = reversePath(partialEdgePath(projection.edge.coordinates, projection, 'to'));
        appendPath(toSuffix, [accessPlan.endpoint]);

        return [
          {
            nodeId: projection.edge.from,
            pathSuffix: fromSuffix,
            selectionPenaltyM: fromDistance + accessPlan.selectionPenaltyM,
            destinationAccessPoint: accessPlan.endpoint,
            warningMessage: 'Using building boundary access fallback near destination.',
          } satisfies RouteDestinationCandidate,
          {
            nodeId: projection.edge.to,
            pathSuffix: toSuffix,
            selectionPenaltyM: toDistance + accessPlan.selectionPenaltyM,
            destinationAccessPoint: accessPlan.endpoint,
            warningMessage: 'Using building boundary access fallback near destination.',
          } satisfies RouteDestinationCandidate,
        ];
      });
    })
  );
};

const buildEnclosedBoundaryDestinationCandidates = ({
  graph,
  destinationFeature,
  destinationId,
  candidateEdges,
  blockingStructureFeatures,
  projectionIndex,
}: {
  graph: CampusRoutingGraph;
  destinationFeature: LocationFeature;
  destinationId: string;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteDestinationCandidate[] => {
  return dedupeDestinationCandidates([
    ...buildEnclosedBoundaryNodeDestinationCandidates({
      graph,
      destinationFeature,
      destinationId,
      blockingStructureFeatures,
    }),
    ...buildEnclosedBoundaryProjectedDestinationCandidates({
      destinationFeature,
      destinationId,
      candidateEdges,
      blockingStructureFeatures,
      projectionIndex,
    }),
  ]);
};

const resolveDestinationCandidates = (
  graph: CampusRoutingGraph,
  destinationId: string,
  destination: [number, number],
  candidateEdges: RoutingGraphEdge[],
  blockingStructureFeatures: BlockingStructureFeature[],
  destinationFeature?: LocationFeature | null,
  projectionIndex?: RoutingProjectionIndex | null
): ResolvedDestinationCandidates => {
  const destinationAccessMode = resolveRoutingAccessMode(destinationFeature);
  const treatAsOpenArea =
    destinationAccessMode === 'open_area' ||
    (destinationAccessMode !== 'entrance' && isOpenAreaFeature(destinationFeature));

  if (treatAsOpenArea && destinationFeature) {
    const openAreaCandidates = buildOpenAreaDestinationCandidates({
      graph,
      destinationFeature,
      destinationId,
      candidateEdges,
      blockingStructureFeatures,
      projectionIndex,
    });

    if (openAreaCandidates.length > 0) {
      return {
        candidateGroups: [openAreaCandidates],
      };
    }
  }

  const candidateGroups: RouteDestinationCandidate[][] = [];
  const entranceNodes = resolveEntranceNodes(graph, destinationId);
  const { explicitNodes: explicitEntranceNodes, inferredNodes: inferredEntranceNodes } =
    splitEntranceNodesByOwnership(entranceNodes, destinationId);

  const buildDirectEntranceCandidates = (
    nodes: RoutingGraphNode[],
    warningMessage?: string
  ): RouteDestinationCandidate[] =>
    nodes
      .filter((node) => nodeHasGraphConnection(graph, node.id))
      .map<RouteDestinationCandidate>((node) => ({
        nodeId: node.id,
        pathSuffix: [node.coordinates],
        selectionPenaltyM: 0,
        destinationAccessPoint: node.coordinates,
        warningMessage,
      }));

  const buildProjectedEntranceCandidates = (
    nodes: RoutingGraphNode[],
    warningMessage?: string
  ): RouteDestinationCandidate[] =>
    dedupeDestinationCandidates(
      nodes.flatMap((entranceNode) =>
        buildProjectedEntranceDestinationCandidates({
          entranceNode,
          candidateEdges,
          blockingStructureFeatures,
          warningMessage,
          projectionIndex,
        })
      )
    );

  if (entranceNodes.length > 0) {
    const directExplicitEntranceCandidates = buildDirectEntranceCandidates(explicitEntranceNodes);
    if (directExplicitEntranceCandidates.length > 0) {
      candidateGroups.push(dedupeDestinationCandidates(directExplicitEntranceCandidates));
    }

    const directInferredEntranceCandidates = buildDirectEntranceCandidates(
      inferredEntranceNodes,
      'Using inferred destination entrance fallback.'
    );
    if (directInferredEntranceCandidates.length > 0) {
      candidateGroups.push(dedupeDestinationCandidates(directInferredEntranceCandidates));
    }

    const projectedExplicitEntranceCandidates = buildProjectedEntranceCandidates(explicitEntranceNodes);
    if (projectedExplicitEntranceCandidates.length > 0) {
      candidateGroups.push(projectedExplicitEntranceCandidates);
    }

    const projectedInferredEntranceCandidates = buildProjectedEntranceCandidates(
      inferredEntranceNodes,
      'Using inferred destination entrance fallback.'
    );
    if (projectedInferredEntranceCandidates.length > 0) {
      candidateGroups.push(projectedInferredEntranceCandidates);
    }
  }

  if (destinationFeature && supportsEnclosedBoundaryAccess(destinationFeature)) {
    const enclosedBoundaryCandidates = buildEnclosedBoundaryDestinationCandidates({
      graph,
      destinationFeature,
      destinationId,
      candidateEdges,
      blockingStructureFeatures,
      projectionIndex,
    });

    if (enclosedBoundaryCandidates.length > 0) {
      candidateGroups.push(enclosedBoundaryCandidates);
    }
  }

  const nearbyConnectedCandidates = nearestNodeEntries(
    graph,
    destination,
    DESTINATION_CANDIDATE_COUNT,
    {
      connectedOnly: true,
      maxDistanceM: DESTINATION_NEARBY_NODE_MAX_DISTANCE_M,
    }
  )
    .map<RouteDestinationCandidate | null>((entry) => {
      const node = graph.nodes.get(entry.id);
      if (!node) {
        return null;
      }

      const openAreaAccessPlan =
        treatAsOpenArea && destinationFeature
          ? buildOpenAreaAccessPlan(destinationFeature, node.coordinates)
          : null;

      if (treatAsOpenArea && destinationFeature && !openAreaAccessPlan) {
        return null;
      }

      if (
        treatAsOpenArea &&
        destinationFeature &&
        openAreaAccessPlan &&
        pathCrossesBlockingStructures(
          [node.coordinates, openAreaAccessPlan.endpoint],
          blockingStructureFeatures,
          {
            allowedLocationIds: destinationId ? [destinationId] : null,
          }
        )
      ) {
        return null;
      }

      return {
        nodeId: node.id,
        pathSuffix:
          treatAsOpenArea && openAreaAccessPlan ? [openAreaAccessPlan.endpoint] : [node.coordinates],
        selectionPenaltyM:
          treatAsOpenArea && openAreaAccessPlan
            ? openAreaAccessPlan.selectionPenaltyM
            : entry.distance,
        destinationAccessPoint:
          treatAsOpenArea && openAreaAccessPlan ? openAreaAccessPlan.endpoint : node.coordinates,
        warningMessage: treatAsOpenArea
          ? 'Using nearby open-area boundary access fallback near destination.'
          : 'Using nearby reachable access fallback near destination.',
      };
    })
    .filter((candidate): candidate is RouteDestinationCandidate => candidate !== null);

  if (nearbyConnectedCandidates.length > 0) {
    candidateGroups.push(dedupeDestinationCandidates(nearbyConnectedCandidates));
  }

  return {
    candidateGroups,
  };
};

const resolveEntranceNodeIds = (graph: CampusRoutingGraph, locationId?: string | null): string[] => {
  if (!locationId) {
    return [];
  }

  return (graph.entrancesByLocationId.get(locationId) ?? []).filter((nodeId) => graph.nodes.has(nodeId));
};

const resolveEntranceNodes = (
  graph: CampusRoutingGraph,
  locationId?: string | null
): RoutingGraphNode[] => {
  return resolveEntranceNodeIds(graph, locationId)
    .map((nodeId) => graph.nodes.get(nodeId))
    .filter((node): node is RoutingGraphNode => Boolean(node));
};

const splitEntranceNodesByOwnership = (
  entranceNodes: RoutingGraphNode[],
  locationId?: string | null
): {
  explicitNodes: RoutingGraphNode[];
  inferredNodes: RoutingGraphNode[];
} => {
  const explicitNodes = entranceNodes.filter((node) => node.locationId === locationId);
  const inferredNodes = entranceNodes.filter((node) => node.locationId !== locationId);

  return {
    explicitNodes,
    inferredNodes,
  };
};

const resolveEffectiveOriginLocationId = ({
  graph,
  origin,
  originLocationId,
  locations,
}: {
  graph: CampusRoutingGraph;
  origin: [number, number];
  originLocationId?: string | null;
  locations?: FeatureCollection<Geometry, Record<string, unknown>> | null;
}): string | null => {
  if (originLocationId) {
    return originLocationId;
  }

  if (!locations?.features?.length) {
    return originLocationId ?? null;
  }

  const originPoint = toMapPoint(origin);
  let bestMatch: { locationId: string; distanceM: number; entranceDistanceM: number } | null = null;

  for (const [index, feature] of locations.features.entries()) {
    const locationId = resolveFeatureId(feature, index);
    if (!locationId) {
      continue;
    }

    if (!supportsEnclosedBoundaryAccess(feature)) {
      continue;
    }

    const entranceNodes = resolveEntranceNodes(graph, locationId);
    const distanceM = featureDistanceToPointMeters(feature, originPoint);
    if (!Number.isFinite(distanceM) || distanceM > ORIGIN_LOCATION_FALLBACK_DISTANCE_M) {
      continue;
    }

    const entranceDistanceM = entranceNodes.reduce((bestDistance, node) => {
      return Math.min(bestDistance, haversineMeters(origin, node.coordinates));
    }, Number.POSITIVE_INFINITY);

    if (
      !bestMatch ||
      distanceM < bestMatch.distanceM ||
      (Math.abs(distanceM - bestMatch.distanceM) < 0.5 && entranceDistanceM < bestMatch.entranceDistanceM)
    ) {
      bestMatch = {
        locationId,
        distanceM,
        entranceDistanceM,
      };
    }
  }

  if (bestMatch) {
    return bestMatch.locationId;
  }

  return originLocationId ?? null;
};

interface EntranceApproachPlan {
  approachPath: [number, number][];
  selectionPenaltyM: number;
  snappedOrigin: [number, number];
  offRouteDistanceM: number;
  warningMessage?: string;
}

const buildEntranceApproachPlan = ({
  origin,
  entrancePoint,
  blockingStructureFeatures,
  locationId,
  inferred,
}: {
  origin: [number, number];
  entrancePoint: [number, number];
  blockingStructureFeatures: BlockingStructureFeature[];
  locationId?: string | null;
  inferred: boolean;
}): EntranceApproachPlan => {
  const distanceToEntrance = haversineMeters(origin, entrancePoint);
  const blockedByStructure = pathCrossesBlockingStructures(
    [origin, entrancePoint],
    blockingStructureFeatures,
    {
      allowedLocationIds: locationId ? [locationId] : null,
    }
  );

  if (blockedByStructure) {
    return {
      approachPath: [entrancePoint],
      selectionPenaltyM: distanceToEntrance,
      snappedOrigin: entrancePoint,
      offRouteDistanceM: distanceToEntrance,
      warningMessage: inferred
        ? 'Starting route from a nearby entrance because indoor routing is not mapped.'
        : 'Starting route from the building entrance because indoor routing is not mapped.',
    };
  }

  return {
    approachPath: [origin, entrancePoint],
    selectionPenaltyM: distanceToEntrance,
    snappedOrigin: origin,
    offRouteDistanceM: 0,
    warningMessage: inferred ? 'Using inferred origin entrance fallback.' : undefined,
  };
};

const reversePath = (path: [number, number][]): [number, number][] => {
  return [...path].reverse();
};

const projectionIndexCellKey = (cellX: number, cellY: number): string => `${cellX}:${cellY}`;

const projectionIndexCellCoords = (
  point: [number, number],
  projectionIndex: RoutingProjectionIndex
): { cellX: number; cellY: number } => {
  return {
    cellX: Math.floor((point[1] * projectionIndex.lngFactor) / projectionIndex.cellSizeM),
    cellY: Math.floor((point[0] * projectionIndex.latFactor) / projectionIndex.cellSizeM),
  };
};

export const buildRoutingProjectionIndex = (
  graphOrEdges: CampusRoutingGraph | RoutingGraphEdge[] | null | undefined
): RoutingProjectionIndex | null => {
  const edges = Array.isArray(graphOrEdges)
    ? graphOrEdges
    : graphOrEdges?.edges ?? [];

  if (edges.length === 0) {
    return null;
  }

  const referenceLat =
    edges.reduce((total, edge) => total + (edge.coordinates[0]?.[0] ?? 0), 0) /
    Math.max(1, edges.length);
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));
  const cells = new Map<string, IndexedEdgeSegment[]>();

  edges.forEach((edge) => {
    for (let segmentIndex = 0; segmentIndex < edge.coordinates.length - 1; segmentIndex += 1) {
      const start = edge.coordinates[segmentIndex];
      const end = edge.coordinates[segmentIndex + 1];
      const minLng = Math.min(start[1], end[1]) * lngFactor;
      const maxLng = Math.max(start[1], end[1]) * lngFactor;
      const minLat = Math.min(start[0], end[0]) * latFactor;
      const maxLat = Math.max(start[0], end[0]) * latFactor;
      const startCellX = Math.floor(minLng / PROJECTION_INDEX_CELL_SIZE_M);
      const endCellX = Math.floor(maxLng / PROJECTION_INDEX_CELL_SIZE_M);
      const startCellY = Math.floor(minLat / PROJECTION_INDEX_CELL_SIZE_M);
      const endCellY = Math.floor(maxLat / PROJECTION_INDEX_CELL_SIZE_M);

      for (let cellX = startCellX; cellX <= endCellX; cellX += 1) {
        for (let cellY = startCellY; cellY <= endCellY; cellY += 1) {
          const key = projectionIndexCellKey(cellX, cellY);
          const existing = cells.get(key) ?? [];
          existing.push({
            edgeId: edge.id,
            segmentIndex,
          });
          cells.set(key, existing);
        }
      }
    }
  });

  return {
    cellSizeM: PROJECTION_INDEX_CELL_SIZE_M,
    referenceLat,
    latFactor,
    lngFactor,
    cells,
  };
};

const findClosestEdgeProjections = (
  point: [number, number],
  edges: RoutingGraphEdge[],
  maxDistanceM: number,
  count?: number,
  projectionIndex?: RoutingProjectionIndex | null
): EdgeProjection[] => {
  const projections: EdgeProjection[] = [];

  if (projectionIndex) {
    const allowedEdgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const visitedSegments = new Set<string>();
    const { cellX, cellY } = projectionIndexCellCoords(point, projectionIndex);
    const searchRadiusCells = Math.max(1, Math.ceil(maxDistanceM / projectionIndex.cellSizeM));

    for (let dx = -searchRadiusCells; dx <= searchRadiusCells; dx += 1) {
      for (let dy = -searchRadiusCells; dy <= searchRadiusCells; dy += 1) {
        const entries = projectionIndex.cells.get(projectionIndexCellKey(cellX + dx, cellY + dy)) ?? [];

        entries.forEach((entry) => {
          const segmentKey = `${entry.edgeId}:${entry.segmentIndex}`;
          if (visitedSegments.has(segmentKey)) {
            return;
          }

          visitedSegments.add(segmentKey);
          const edge = allowedEdgesById.get(entry.edgeId);
          if (!edge) {
            return;
          }

          const segmentStart = edge.coordinates[entry.segmentIndex];
          const segmentEnd = edge.coordinates[entry.segmentIndex + 1];
          if (!segmentStart || !segmentEnd) {
            return;
          }

          const projection = projectToSegment(point, segmentStart, segmentEnd);
          if (projection.distanceM > maxDistanceM) {
            return;
          }

          projections.push({
            edge,
            point: projection.point,
            t: projection.t,
            distanceM: projection.distanceM,
            segmentIndex: entry.segmentIndex,
          });
        });
      }
    }
  } else {
    edges.forEach((edge) => {
      const coordinates = edge.coordinates;

      for (let index = 0; index < coordinates.length - 1; index += 1) {
        const projection = projectToSegment(point, coordinates[index], coordinates[index + 1]);

        if (projection.distanceM <= maxDistanceM) {
          projections.push({
            edge,
            point: projection.point,
            t: projection.t,
            distanceM: projection.distanceM,
            segmentIndex: index,
          });
        }
      }
    });
  }

  const sorted = projections.sort((left, right) => {
    if (left.distanceM !== right.distanceM) {
      return left.distanceM - right.distanceM;
    }

    if (left.edge.id !== right.edge.id) {
      return left.edge.id.localeCompare(right.edge.id);
    }

    return left.segmentIndex - right.segmentIndex;
  });

  if (typeof count !== 'number') {
    return sorted;
  }

  return sorted.slice(0, count);
};

const partialEdgePath = (
  edgeCoordinates: [number, number][],
  projection: EdgeProjection,
  toward: 'from' | 'to'
): [number, number][] => {
  const partial: [number, number][] = [projection.point];

  if (toward === 'from') {
    for (let index = projection.segmentIndex; index >= 0; index -= 1) {
      appendPath(partial, [edgeCoordinates[index]]);
    }
    return partial;
  }

  for (let index = projection.segmentIndex + 1; index < edgeCoordinates.length; index += 1) {
    appendPath(partial, [edgeCoordinates[index]]);
  }

  return partial;
};

const distanceAlongEdgeFromStart = (
  edgeCoordinates: [number, number][],
  projection: EdgeProjection
): number => {
  const lengths = segmentLengths(edgeCoordinates);
  const cumulative = cumulativeLengths(lengths);
  const currentSegmentLength = lengths[projection.segmentIndex] ?? 0;

  return cumulative[projection.segmentIndex] + currentSegmentLength * projection.t;
};

const buildProjectedEntranceStartCandidates = ({
  entranceNode,
  approachPlan,
  candidateEdges,
  blockingStructureFeatures,
  projectionIndex,
}: {
  entranceNode: RoutingGraphNode;
  approachPlan: EntranceApproachPlan;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteStartCandidate[] => {
  const projectableEdges = candidateEdges.filter((edge) => edge.sourceKind !== 'synthetic_connector');
  const projections = findClosestEdgeProjections(
    entranceNode.coordinates,
    projectableEdges,
    ENTRANCE_EDGE_MAX_DISTANCE_M,
    undefined,
    projectionIndex
  );

  return projections.flatMap((projection) => {
    if (
      pathCrossesBlockingStructures(
        [entranceNode.coordinates, projection.point],
        blockingStructureFeatures
      )
    ) {
      return [];
    }

    const fromDistance = distanceAlongEdgeFromStart(projection.edge.coordinates, projection);
    const toDistance = Math.max(0, projection.edge.distance_m - fromDistance);

    const fromPrefix: [number, number][] = [];
    appendPath(fromPrefix, approachPlan.approachPath);
    appendPath(fromPrefix, [entranceNode.coordinates, projection.point]);
    appendPath(fromPrefix, partialEdgePath(projection.edge.coordinates, projection, 'from'));

    const toPrefix: [number, number][] = [];
    appendPath(toPrefix, approachPlan.approachPath);
    appendPath(toPrefix, [entranceNode.coordinates, projection.point]);
    appendPath(toPrefix, partialEdgePath(projection.edge.coordinates, projection, 'to'));

      return [
        {
          nodeId: projection.edge.from,
          selectionPenaltyM:
            approachPlan.selectionPenaltyM + projection.distanceM + fromDistance,
          pathPrefix: fromPrefix,
          snappedOrigin: approachPlan.snappedOrigin,
          offRouteDistanceM: approachPlan.offRouteDistanceM + projection.distanceM,
          originAccessPoint: entranceNode.coordinates,
          warningMessage: approachPlan.warningMessage,
        },
        {
          nodeId: projection.edge.to,
          selectionPenaltyM:
            approachPlan.selectionPenaltyM + projection.distanceM + toDistance,
          pathPrefix: toPrefix,
          snappedOrigin: approachPlan.snappedOrigin,
          offRouteDistanceM: approachPlan.offRouteDistanceM + projection.distanceM,
          originAccessPoint: entranceNode.coordinates,
          warningMessage: approachPlan.warningMessage,
        },
      ];
    });
};

const buildProjectedEntranceDestinationCandidates = ({
  entranceNode,
  candidateEdges,
  blockingStructureFeatures,
  warningMessage,
  projectionIndex,
}: {
  entranceNode: RoutingGraphNode;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  warningMessage?: string;
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteDestinationCandidate[] => {
  const projectableEdges = candidateEdges.filter((edge) => edge.sourceKind !== 'synthetic_connector');
  const projections = findClosestEdgeProjections(
    entranceNode.coordinates,
    projectableEdges,
    ENTRANCE_EDGE_MAX_DISTANCE_M,
    undefined,
    projectionIndex
  );

  return projections.flatMap((projection) => {
    if (
      pathCrossesBlockingStructures(
        [projection.point, entranceNode.coordinates],
        blockingStructureFeatures
      )
    ) {
      return [];
    }

    const fromDistance = distanceAlongEdgeFromStart(projection.edge.coordinates, projection);
    const toDistance = Math.max(0, projection.edge.distance_m - fromDistance);

    const fromSuffix = reversePath(partialEdgePath(projection.edge.coordinates, projection, 'from'));
    appendPath(fromSuffix, [entranceNode.coordinates]);

    const toSuffix = reversePath(partialEdgePath(projection.edge.coordinates, projection, 'to'));
    appendPath(toSuffix, [entranceNode.coordinates]);

    return [
      {
        nodeId: projection.edge.from,
        pathSuffix: fromSuffix,
        selectionPenaltyM: projection.distanceM + fromDistance,
        destinationAccessPoint: entranceNode.coordinates,
        warningMessage,
      },
      {
        nodeId: projection.edge.to,
        pathSuffix: toSuffix,
        selectionPenaltyM: projection.distanceM + toDistance,
        destinationAccessPoint: entranceNode.coordinates,
        warningMessage,
      },
    ];
  });
};

const comparePriorityQueueEntries = (left: PriorityQueueEntry, right: PriorityQueueEntry): number => {
  if (left.estimatedChoiceCostM !== right.estimatedChoiceCostM) {
    return left.estimatedChoiceCostM - right.estimatedChoiceCostM;
  }

  const metricsComparison = compareRouteCostMetrics(left.metrics, right.metrics);
  if (metricsComparison !== 0) {
    return metricsComparison;
  }

  return left.nodeId.localeCompare(right.nodeId);
};

class MinPriorityQueue<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  peek(): T | undefined {
    return this.items[0];
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }

    const first = this.items[0];
    const last = this.items.pop();

    if (last && this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }

    return first;
  }

  private bubbleUp(index: number): void {
    let cursor = index;

    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.compare(this.items[cursor], this.items[parent]) >= 0) {
        break;
      }

      [this.items[cursor], this.items[parent]] = [this.items[parent], this.items[cursor]];
      cursor = parent;
    }
  }

  private bubbleDown(index: number): void {
    let cursor = index;

    while (true) {
      const leftChild = cursor * 2 + 1;
      const rightChild = leftChild + 1;
      let next = cursor;

      if (leftChild < this.items.length && this.compare(this.items[leftChild], this.items[next]) < 0) {
        next = leftChild;
      }

      if (rightChild < this.items.length && this.compare(this.items[rightChild], this.items[next]) < 0) {
        next = rightChild;
      }

      if (next === cursor) {
        break;
      }

      [this.items[cursor], this.items[next]] = [this.items[next], this.items[cursor]];
      cursor = next;
    }
  }
}

const buildReverseRoutingAdjacency = (
  graph: CampusRoutingGraph
): Map<string, ReverseRoutingAdjacency[]> => {
  const reverseAdjacency = new Map<string, ReverseRoutingAdjacency[]>();

  graph.nodes.forEach((_node, nodeId) => {
    reverseAdjacency.set(nodeId, []);
  });

  graph.adjacency.forEach((neighbors, nodeId) => {
    neighbors.forEach((neighbor) => {
      const edge = graph.edgesById.get(neighbor.edgeId);
      if (!edge) {
        return;
      }

      reverseAdjacency.get(neighbor.neighborId)?.push({
        nodeId,
        traversal: {
          edge,
          reverse: neighbor.reverse,
        },
      });
    });
  });

  return reverseAdjacency;
};

const queueEntryFromMetrics = (nodeId: string, metrics: RouteCostMetrics): PriorityQueueEntry => {
  return {
    nodeId,
    estimatedChoiceCostM: metrics.choiceCostM,
    metrics,
  };
};

const findContainingCompoundIds = (
  locations: FeatureCollection<Geometry, Record<string, unknown>> | null | undefined,
  point: [number, number]
): string[] => {
  if (!locations?.features?.length) {
    return [];
  }

  const mapPoint = toMapPoint(point);
  return locations.features
    .map((feature, index) => ({
      id: resolveFeatureId(feature, index),
      feature,
    }))
    .filter((entry): entry is { id: string; feature: LocationFeature } => {
      return Boolean(entry.id) && isBoundaryFeature(entry.feature) && featureContainsPoint(entry.feature, mapPoint);
    })
    .map((entry) => entry.id);
};

const resolveRequiredCompoundGateGroups = ({
  graph,
  locations,
  origin,
  destination,
}: {
  graph: CampusRoutingGraph;
  locations: FeatureCollection<Geometry, Record<string, unknown>> | null | undefined;
  origin: [number, number];
  destination: [number, number];
}): {
  gateGroups: RequiredGateGroup[];
  missingCompoundIds: string[];
} => {
  const originCompoundIds = findContainingCompoundIds(locations, origin);
  const destinationCompoundIds = findContainingCompoundIds(locations, destination);
  const originCompounds = new Set(originCompoundIds);
  const destinationCompounds = new Set(destinationCompoundIds);
  const crossingCompoundIds = [
    ...originCompoundIds.filter((compoundId) => !destinationCompounds.has(compoundId)),
    ...destinationCompoundIds.filter((compoundId) => !originCompounds.has(compoundId)),
  ].filter((compoundId, index, list) => list.indexOf(compoundId) === index);

  const gateGroups: RequiredGateGroup[] = [];
  const missingCompoundIds: string[] = [];

  crossingCompoundIds.forEach((compoundId) => {
    const gateNodeIds = (graph.entrancesByLocationId.get(compoundId) ?? []).filter((nodeId) => {
      const node = graph.nodes.get(nodeId);
      return Boolean(node && node.locationId === compoundId && nodeHasGraphConnection(graph, nodeId));
    });

    if (gateNodeIds.length === 0) {
      missingCompoundIds.push(compoundId);
      return;
    }

    gateGroups.push({
      compoundId,
      nodeIds: gateNodeIds,
    });
  });

  return {
    gateGroups,
    missingCompoundIds,
  };
};

const routeSatisfiesRequiredGates = (
  nodeIds: string[],
  requiredGateGroups: RequiredGateGroup[] | undefined
): boolean => {
  if (!requiredGateGroups || requiredGateGroups.length === 0) {
    return true;
  }

  const routeNodeIds = new Set(nodeIds);
  return requiredGateGroups.every((group) => group.nodeIds.some((nodeId) => routeNodeIds.has(nodeId)));
};

const appendDijkstraSegment = (target: DijkstraResult, segment: DijkstraResult): void => {
  target.choiceCostM += segment.choiceCostM;
  target.distanceM += segment.distanceM;
  target.etaCostM += segment.etaCostM;
  target.syntheticSegmentCount += segment.syntheticSegmentCount;
  target.traversals.push(...segment.traversals);
  target.nodeIds.push(...segment.nodeIds.slice(target.nodeIds.length > 0 ? 1 : 0));
};

const shortestPathThroughRequiredGates = (
  graph: CampusRoutingGraph,
  startNodeId: string,
  endNodeId: string,
  mode: RouteAccessibilityMode,
  requiredGateGroups: RequiredGateGroup[],
  blockedEdgeIds?: ReadonlySet<string>
): DijkstraResult | null => {
  let bestResult: DijkstraResult | null = null;

  const visitGateGroup = (
    groupIndex: number,
    currentNodeId: string,
    accumulated: DijkstraResult
  ): void => {
    if (groupIndex >= requiredGateGroups.length) {
      const finalSegment = shortestPath(graph, currentNodeId, endNodeId, mode, blockedEdgeIds);
      if (!finalSegment) {
        return;
      }

      const candidate: DijkstraResult = {
        choiceCostM: accumulated.choiceCostM,
        distanceM: accumulated.distanceM,
        etaCostM: accumulated.etaCostM,
        syntheticSegmentCount: accumulated.syntheticSegmentCount,
        traversals: [...accumulated.traversals],
        nodeIds: [...accumulated.nodeIds],
      };
      appendDijkstraSegment(candidate, finalSegment);

      if (!bestResult || compareRouteCostMetrics(candidate, bestResult) < 0) {
        bestResult = candidate;
      }
      return;
    }

    const gateGroup = requiredGateGroups[groupIndex];
    gateGroup.nodeIds.forEach((gateNodeId) => {
      const segment = shortestPath(graph, currentNodeId, gateNodeId, mode, blockedEdgeIds);
      if (!segment) {
        return;
      }

      const nextAccumulated: DijkstraResult = {
        choiceCostM: accumulated.choiceCostM,
        distanceM: accumulated.distanceM,
        etaCostM: accumulated.etaCostM,
        syntheticSegmentCount: accumulated.syntheticSegmentCount,
        traversals: [...accumulated.traversals],
        nodeIds: [...accumulated.nodeIds],
      };
      appendDijkstraSegment(nextAccumulated, segment);
      visitGateGroup(groupIndex + 1, gateNodeId, nextAccumulated);
    });
  };

  visitGateGroup(0, startNodeId, {
    choiceCostM: 0,
    distanceM: 0,
    etaCostM: 0,
    syntheticSegmentCount: 0,
    traversals: [],
    nodeIds: [],
  });

  return bestResult;
};

const candidateBeatsBestRoute = (
  candidateMetrics: RouteCostMetrics,
  candidateMeetingNodeId: string,
  bestMetrics: RouteCostMetrics | null,
  bestMeetingNodeId: string | null
): boolean => {
  if (!bestMetrics || !bestMeetingNodeId) {
    return true;
  }

  const comparison = compareRouteCostMetrics(candidateMetrics, bestMetrics);
  if (comparison !== 0) {
    return comparison < 0;
  }

  return candidateMeetingNodeId.localeCompare(bestMeetingNodeId) < 0;
};

const combinedQueueLowerBound = (
  left: MinPriorityQueue<PriorityQueueEntry>,
  right: MinPriorityQueue<PriorityQueueEntry>
): RouteCostMetrics | null => {
  const leftEntry = left.peek();
  const rightEntry = right.peek();

  if (!leftEntry || !rightEntry) {
    return null;
  }

  return addRouteCostMetrics(leftEntry.metrics, rightEntry.metrics);
};

const shortestPath = (
  graph: CampusRoutingGraph,
  startNodeId: string,
  endNodeId: string,
  mode: RouteAccessibilityMode,
  blockedEdgeIds?: ReadonlySet<string>
): DijkstraResult | null => {
  if (!graph.nodes.has(startNodeId) || !graph.nodes.has(endNodeId)) {
    return null;
  }

  if (startNodeId === endNodeId) {
    return {
      choiceCostM: 0,
      distanceM: 0,
      etaCostM: 0,
      syntheticSegmentCount: 0,
      traversals: [],
      nodeIds: [startNodeId],
    };
  }

  const reverseAdjacency = buildReverseRoutingAdjacency(graph);
  const forwardDistances = new Map<string, RouteCostMetrics>();
  const backwardDistances = new Map<string, RouteCostMetrics>();
  const forwardPrevious = new Map<string, { nodeId: string; traversal: PathTraversal }>();
  const backwardPrevious = new Map<string, { nodeId: string; traversal: PathTraversal }>();
  const settledForward = new Set<string>();
  const settledBackward = new Set<string>();
  const forwardQueue = new MinPriorityQueue<PriorityQueueEntry>(comparePriorityQueueEntries);
  const backwardQueue = new MinPriorityQueue<PriorityQueueEntry>(comparePriorityQueueEntries);

  const bestRoute: {
    meetingNodeId: string | null;
    metrics: RouteCostMetrics | null;
  } = {
    meetingNodeId: null,
    metrics: null,
  };

  const recordBestRoute = (nodeId: string): void => {
    const forwardDistance = forwardDistances.get(nodeId);
    const backwardDistance = backwardDistances.get(nodeId);
    if (!forwardDistance || !backwardDistance) {
      return;
    }

    const combinedMetrics = addRouteCostMetrics(forwardDistance, backwardDistance);
    if (candidateBeatsBestRoute(combinedMetrics, nodeId, bestRoute.metrics, bestRoute.meetingNodeId)) {
      bestRoute.meetingNodeId = nodeId;
      bestRoute.metrics = combinedMetrics;
    }
  };

  forwardDistances.set(startNodeId, ZERO_ROUTE_COST_METRICS);
  backwardDistances.set(endNodeId, ZERO_ROUTE_COST_METRICS);
  forwardQueue.push(queueEntryFromMetrics(startNodeId, ZERO_ROUTE_COST_METRICS));
  backwardQueue.push(queueEntryFromMetrics(endNodeId, ZERO_ROUTE_COST_METRICS));

  while (forwardQueue.size > 0 && backwardQueue.size > 0) {
    const lowerBound = combinedQueueLowerBound(forwardQueue, backwardQueue);
    if (bestRoute.metrics && (!lowerBound || compareRouteCostMetrics(lowerBound, bestRoute.metrics) >= 0)) {
      break;
    }

    const forwardTop = forwardQueue.peek();
    const backwardTop = backwardQueue.peek();
    const expandForward =
      !backwardTop ||
      (forwardTop ? comparePriorityQueueEntries(forwardTop, backwardTop) <= 0 : false);

    if (expandForward) {
      const current = forwardQueue.pop();
      if (!current) {
        break;
      }

      const activeDistance = forwardDistances.get(current.nodeId);
      if (!activeDistance || compareRouteCostMetrics(activeDistance, current.metrics) !== 0) {
        continue;
      }

      if (settledForward.has(current.nodeId)) {
        continue;
      }

      settledForward.add(current.nodeId);
      recordBestRoute(current.nodeId);

      const neighbors = graph.adjacency.get(current.nodeId) ?? [];

      neighbors.forEach((neighbor) => {
        const edge = graph.edgesById.get(neighbor.edgeId);
        if (!edge || !edgeUsableForRouting(edge, mode, blockedEdgeIds)) {
          return;
        }

        const tentativeDistance = addRouteCostMetrics(activeDistance, edgeRouteCostMetrics(edge));
        const knownDistance = forwardDistances.get(neighbor.neighborId);

        if (!knownDistance || compareRouteCostMetrics(tentativeDistance, knownDistance) < 0) {
          forwardDistances.set(neighbor.neighborId, tentativeDistance);
          forwardPrevious.set(neighbor.neighborId, {
            nodeId: current.nodeId,
            traversal: {
              edge,
              reverse: neighbor.reverse,
            },
          });
          forwardQueue.push(queueEntryFromMetrics(neighbor.neighborId, tentativeDistance));
          recordBestRoute(neighbor.neighborId);
        }
      });

      continue;
    }

    const current = backwardQueue.pop();
    if (!current) {
      break;
    }

    const activeDistance = backwardDistances.get(current.nodeId);
    if (!activeDistance || compareRouteCostMetrics(activeDistance, current.metrics) !== 0) {
      continue;
    }

    if (settledBackward.has(current.nodeId)) {
      continue;
    }

    settledBackward.add(current.nodeId);
    recordBestRoute(current.nodeId);

    const neighbors = reverseAdjacency.get(current.nodeId) ?? [];

    neighbors.forEach((neighbor) => {
      if (!edgeUsableForRouting(neighbor.traversal.edge, mode, blockedEdgeIds)) {
        return;
      }

      const tentativeDistance = addRouteCostMetrics(
        activeDistance,
        edgeRouteCostMetrics(neighbor.traversal.edge)
      );
      const knownDistance = backwardDistances.get(neighbor.nodeId);

      if (!knownDistance || compareRouteCostMetrics(tentativeDistance, knownDistance) < 0) {
        backwardDistances.set(neighbor.nodeId, tentativeDistance);
        backwardPrevious.set(neighbor.nodeId, {
          nodeId: current.nodeId,
          traversal: neighbor.traversal,
        });
        backwardQueue.push(queueEntryFromMetrics(neighbor.nodeId, tentativeDistance));
        recordBestRoute(neighbor.nodeId);
      }
    });
  }

  if (!bestRoute.meetingNodeId || !bestRoute.metrics) {
    return null;
  }

  const finalMeetingNodeId = bestRoute.meetingNodeId;
  const finalMetrics = bestRoute.metrics;
  const traversals: PathTraversal[] = [];
  const nodeIds: string[] = [finalMeetingNodeId];
  let cursor = finalMeetingNodeId;

  while (cursor !== startNodeId) {
    const entry = forwardPrevious.get(cursor);
    if (!entry) {
      return null;
    }

    traversals.unshift(entry.traversal);
    cursor = entry.nodeId;
    nodeIds.unshift(cursor);
  }

  cursor = finalMeetingNodeId;

  while (cursor !== endNodeId) {
    const entry = backwardPrevious.get(cursor);
    if (!entry) {
      return null;
    }

    traversals.push(entry.traversal);
    cursor = entry.nodeId;
    nodeIds.push(cursor);
  }

  return {
    choiceCostM: finalMetrics.choiceCostM,
    distanceM: finalMetrics.distanceM,
    etaCostM: finalMetrics.etaCostM,
    syntheticSegmentCount: finalMetrics.syntheticSegmentCount,
    traversals,
    nodeIds,
  };
};

const traversalsToPath = (
  graph: CampusRoutingGraph,
  startNodeId: string,
  traversals: PathTraversal[]
): [number, number][] => {
  const startNode = graph.nodes.get(startNodeId);
  if (!startNode) {
    return [];
  }

  const path: [number, number][] = [startNode.coordinates];

  traversals.forEach((traversal) => {
    const traversalCoordinates = traversal.reverse
      ? [...traversal.edge.coordinates].reverse()
      : traversal.edge.coordinates;

    appendPath(path, traversalCoordinates);
  });

  return path;
};

export const runDijkstraRoute = (
  graph: CampusRoutingGraph,
  startNodeId: string,
  endNodeId: string,
  mode: RouteAccessibilityMode
): DijkstraRouteOutput | null => {
  const result = shortestPath(graph, startNodeId, endNodeId, mode);

  if (!result) {
    return null;
  }

  const path = traversalsToPath(graph, startNodeId, result.traversals);
  if (path.length === 0) {
    return null;
  }

  const linePath = path.length >= 2 ? path : [path[0], path[0]];

  return {
    node_ids: result.nodeIds,
    total_distance_m: Math.round(result.distanceM),
    line: pathToGeoJsonLine(linePath),
  };
};

const dedupeStartCandidates = (candidates: RouteStartCandidate[]): RouteStartCandidate[] => {
  const deduped = new Map<string, RouteStartCandidate>();

  candidates.forEach((candidate) => {
    const existing = deduped.get(candidate.nodeId);
    if (!existing || candidate.selectionPenaltyM < existing.selectionPenaltyM) {
      deduped.set(candidate.nodeId, candidate);
    }
  });

  return Array.from(deduped.values()).sort((left, right) => left.selectionPenaltyM - right.selectionPenaltyM);
};

const buildProjectedOriginStartCandidates = (
  origin: [number, number],
  candidateEdges: RoutingGraphEdge[],
  blockingStructureFeatures: BlockingStructureFeature[],
  projectionIndex?: RoutingProjectionIndex | null
): RouteStartCandidate[] | null => {
  const snappedEdges = findClosestEdgeProjections(
    origin,
    candidateEdges,
    ORIGIN_EDGE_MAX_DISTANCE_M,
    ORIGIN_EDGE_CANDIDATE_COUNT,
    projectionIndex
  );
  if (snappedEdges.length === 0) {
    return null;
  }

  return dedupeStartCandidates(
    snappedEdges.flatMap((snapped) => {
      const snappedAccessPath: [number, number][] = [origin, snapped.point];
      if (pathCrossesBlockingStructures(snappedAccessPath, blockingStructureFeatures)) {
        return [];
      }

      const fromDistance = distanceAlongEdgeFromStart(snapped.edge.coordinates, snapped);
      const toDistance = Math.max(0, snapped.edge.distance_m - fromDistance);

      return [
        {
          nodeId: snapped.edge.from,
          selectionPenaltyM: snapped.distanceM + fromDistance,
          pathPrefix: [origin, ...partialEdgePath(snapped.edge.coordinates, snapped, 'from')],
          snappedOrigin: snapped.point,
          offRouteDistanceM: snapped.distanceM,
          originAccessPoint: origin,
        },
        {
          nodeId: snapped.edge.to,
          selectionPenaltyM: snapped.distanceM + toDistance,
          pathPrefix: [origin, ...partialEdgePath(snapped.edge.coordinates, snapped, 'to')],
          snappedOrigin: snapped.point,
          offRouteDistanceM: snapped.distanceM,
          originAccessPoint: origin,
        },
      ];
    })
  );
};

const buildEnclosedBoundaryOriginStartCandidates = ({
  graph,
  origin,
  originFeature,
  originLocationId,
  candidateEdges,
  blockingStructureFeatures,
  projectionIndex,
}: {
  graph: CampusRoutingGraph;
  origin: [number, number];
  originFeature: LocationFeature;
  originLocationId: string;
  candidateEdges: RoutingGraphEdge[];
  blockingStructureFeatures: BlockingStructureFeature[];
  projectionIndex?: RoutingProjectionIndex | null;
}): RouteStartCandidate[] => {
  const warningMessage = 'Starting route from building boundary access because no mapped entrance is available.';
  const hintAllowedIds = originLocationId ? [originLocationId] : null;
  const nodeCandidates = Array.from(graph.nodes.values())
    .filter((node) => nodeHasGraphConnection(graph, node.id))
    .flatMap((node) => {
      const distanceToBoundaryM = featureBoundaryDistanceToPointMeters(originFeature, toMapPoint(node.coordinates));
      if (!Number.isFinite(distanceToBoundaryM) || distanceToBoundaryM > ENCLOSED_BOUNDARY_MAX_DISTANCE_M) {
        return [];
      }

      const accessPlan = buildEnclosedBoundaryAccessPlan(originFeature, node.coordinates);
      if (!accessPlan) {
        return [];
      }

      const hintPath: [number, number][] = [origin, accessPlan.endpoint];
      if (
        pathCrossesBlockingStructures(hintPath, blockingStructureFeatures, {
          allowedLocationIds: hintAllowedIds,
        })
      ) {
        return [];
      }

      const externalConnector: [number, number][] = [accessPlan.endpoint, node.coordinates];
      if (pathCrossesBlockingStructures(externalConnector, blockingStructureFeatures)) {
        return [];
      }

      const pathPrefix: [number, number][] = [];
      appendPath(pathPrefix, hintPath);
      appendPath(pathPrefix, [node.coordinates]);

      return [
        {
          nodeId: node.id,
          selectionPenaltyM: routeDistanceMeters(pathPrefix),
          pathPrefix,
          snappedOrigin: origin,
          offRouteDistanceM: 0,
          originAccessPoint: accessPlan.endpoint,
          originAccessHintPath: hintPath,
          warningMessage,
        } satisfies RouteStartCandidate,
      ];
    });

  const projectableEdges = candidateEdges.filter((edge) => edge.sourceKind !== 'synthetic_connector');
  const samplePoints = collectFeatureBoundarySamplePoints(originFeature);
  const projectedCandidates = samplePoints.flatMap((samplePoint) => {
    const projections = findClosestEdgeProjections(
      fromMapPoint(samplePoint),
      projectableEdges,
      ENCLOSED_BOUNDARY_MAX_DISTANCE_M,
      2,
      projectionIndex
    );

    return projections.flatMap((projection) => {
      const accessPlan = buildEnclosedBoundaryAccessPlan(originFeature, projection.point);
      if (!accessPlan) {
        return [];
      }

      const hintPath: [number, number][] = [origin, accessPlan.endpoint];
      if (
        pathCrossesBlockingStructures(hintPath, blockingStructureFeatures, {
          allowedLocationIds: hintAllowedIds,
        })
      ) {
        return [];
      }

      if (
        pathCrossesBlockingStructures(
          [accessPlan.endpoint, projection.point],
          blockingStructureFeatures
        )
      ) {
        return [];
      }

      const fromDistance = distanceAlongEdgeFromStart(projection.edge.coordinates, projection);
      const toDistance = Math.max(0, projection.edge.distance_m - fromDistance);

      const fromPrefix: [number, number][] = [];
      appendPath(fromPrefix, hintPath);
      appendPath(fromPrefix, [projection.point]);
      appendPath(fromPrefix, partialEdgePath(projection.edge.coordinates, projection, 'from'));

      const toPrefix: [number, number][] = [];
      appendPath(toPrefix, hintPath);
      appendPath(toPrefix, [projection.point]);
      appendPath(toPrefix, partialEdgePath(projection.edge.coordinates, projection, 'to'));

      return [
        {
          nodeId: projection.edge.from,
          selectionPenaltyM:
            haversineMeters(origin, accessPlan.endpoint) + haversineMeters(accessPlan.endpoint, projection.point) + fromDistance,
          pathPrefix: fromPrefix,
          snappedOrigin: origin,
          offRouteDistanceM: 0,
          originAccessPoint: accessPlan.endpoint,
          originAccessHintPath: hintPath,
          warningMessage,
        } satisfies RouteStartCandidate,
        {
          nodeId: projection.edge.to,
          selectionPenaltyM:
            haversineMeters(origin, accessPlan.endpoint) + haversineMeters(accessPlan.endpoint, projection.point) + toDistance,
          pathPrefix: toPrefix,
          snappedOrigin: origin,
          offRouteDistanceM: 0,
          originAccessPoint: accessPlan.endpoint,
          originAccessHintPath: hintPath,
          warningMessage,
        } satisfies RouteStartCandidate,
      ];
    });
  });

  return dedupeStartCandidates([...nodeCandidates, ...projectedCandidates]);
};

const buildEntranceOriginStartCandidateTiers = (
  graph: CampusRoutingGraph,
  origin: [number, number],
  originLocationId: string | null | undefined,
  candidateEdges: RoutingGraphEdge[],
  blockingStructureFeatures: BlockingStructureFeature[],
  projectionIndex?: RoutingProjectionIndex | null
): {
  connectedExplicitCandidates: RouteStartCandidate[];
  connectedInferredCandidates: RouteStartCandidate[];
  projectedExplicitCandidates: RouteStartCandidate[];
  projectedInferredCandidates: RouteStartCandidate[];
} => {
  const entranceNodes = resolveEntranceNodes(graph, originLocationId);
  const { explicitNodes: explicitEntranceNodes, inferredNodes: inferredEntranceNodes } =
    splitEntranceNodesByOwnership(entranceNodes, originLocationId);
  const connectedExplicitCandidates: RouteStartCandidate[] = [];
  const connectedInferredCandidates: RouteStartCandidate[] = [];
  const projectedExplicitCandidates: RouteStartCandidate[] = [];
  const projectedInferredCandidates: RouteStartCandidate[] = [];

  const addCandidatesForEntrances = (
    candidateNodes: RoutingGraphNode[],
    connectedTarget: RouteStartCandidate[],
    projectedTarget: RouteStartCandidate[]
  ): void => {
    candidateNodes.forEach((entranceNode) => {
      const approachPlan = buildEntranceApproachPlan({
        origin,
        entrancePoint: entranceNode.coordinates,
        blockingStructureFeatures,
        locationId: originLocationId,
      inferred: entranceNode.locationId !== originLocationId,
    });

      if (nodeHasGraphConnection(graph, entranceNode.id)) {
        connectedTarget.push({
          nodeId: entranceNode.id,
          selectionPenaltyM: approachPlan.selectionPenaltyM,
          pathPrefix: approachPlan.approachPath,
          snappedOrigin: approachPlan.snappedOrigin,
          offRouteDistanceM: approachPlan.offRouteDistanceM,
          originAccessPoint: entranceNode.coordinates,
          originAccessHintPath:
            approachPlan.approachPath.length >= 2 ? [...approachPlan.approachPath] : null,
          warningMessage: approachPlan.warningMessage,
        });
      }

      projectedTarget.push(
        ...buildProjectedEntranceStartCandidates({
          entranceNode,
          approachPlan,
          candidateEdges,
          blockingStructureFeatures,
          projectionIndex,
        }).map((candidate) => ({
          ...candidate,
          originAccessPoint: entranceNode.coordinates,
          originAccessHintPath:
            approachPlan.approachPath.length >= 2 ? [...approachPlan.approachPath] : null,
        }))
      );
    });
  };

  addCandidatesForEntrances(
    explicitEntranceNodes,
    connectedExplicitCandidates,
    projectedExplicitCandidates
  );
  addCandidatesForEntrances(
    inferredEntranceNodes,
    connectedInferredCandidates,
    projectedInferredCandidates
  );

  return {
    connectedExplicitCandidates: dedupeStartCandidates(connectedExplicitCandidates),
    connectedInferredCandidates: dedupeStartCandidates(connectedInferredCandidates),
    projectedExplicitCandidates: dedupeStartCandidates(projectedExplicitCandidates),
    projectedInferredCandidates: dedupeStartCandidates(projectedInferredCandidates),
  };
};

const combineWarningMessages = (...messages: Array<string | null | undefined>): string | undefined => {
  const uniqueMessages = messages.filter((message): message is string => Boolean(message))
    .filter((message, index, list) => list.indexOf(message) === index);

  if (uniqueMessages.length === 0) {
    return undefined;
  }

  return uniqueMessages.join(' ');
};

interface CandidateRouteMetrics {
  choiceCostM: number;
  distanceM: number;
  etaCostM: number;
  syntheticSegmentCount: number;
}

const compareCandidateRouteMetrics = (
  left: CandidateRouteMetrics,
  right: CandidateRouteMetrics
): number => {
  if (left.choiceCostM !== right.choiceCostM) {
    return left.choiceCostM - right.choiceCostM;
  }

  if (left.distanceM !== right.distanceM) {
    return left.distanceM - right.distanceM;
  }

  if (left.syntheticSegmentCount !== right.syntheticSegmentCount) {
    return left.syntheticSegmentCount - right.syntheticSegmentCount;
  }

  return left.etaCostM - right.etaCostM;
};

const buildGraphRoutePreview = ({
  destinationId,
  destinationCandidates,
  graph,
  accessibilityMode,
  startCandidates,
  warningMessage,
  blockedEdgeIds,
  requiredGateGroups,
}: {
  destinationId: string;
  destinationCandidates: RouteDestinationCandidate[];
  graph: CampusRoutingGraph;
  accessibilityMode: RouteAccessibilityMode;
  startCandidates: RouteStartCandidate[];
  warningMessage?: string;
  blockedEdgeIds?: ReadonlySet<string>;
  requiredGateGroups?: RequiredGateGroup[];
}): RoutePreview | null => {
  const limitedStartCandidates = [...startCandidates]
    .sort((left, right) => left.selectionPenaltyM - right.selectionPenaltyM)
    .slice(0, MAX_ROUTE_START_CANDIDATES);
  const limitedDestinationCandidates = [...destinationCandidates]
    .sort((left, right) => left.selectionPenaltyM - right.selectionPenaltyM)
    .slice(0, MAX_ROUTE_DESTINATION_CANDIDATES);
  let bestRoute:
    | {
        metrics: CandidateRouteMetrics;
        startCandidate: RouteStartCandidate;
        destinationCandidate: RouteDestinationCandidate;
        result: DijkstraResult;
      }
    | null = null;

  for (const startCandidate of limitedStartCandidates) {
    for (const destinationCandidate of limitedDestinationCandidates) {
      const result =
        requiredGateGroups && requiredGateGroups.length > 0
          ? shortestPathThroughRequiredGates(
              graph,
              startCandidate.nodeId,
              destinationCandidate.nodeId,
              accessibilityMode,
              requiredGateGroups,
              blockedEdgeIds
            )
          : shortestPath(
              graph,
              startCandidate.nodeId,
              destinationCandidate.nodeId,
              accessibilityMode,
              blockedEdgeIds
            );
      if (!result) {
        continue;
      }

      if (!routeSatisfiesRequiredGates(result.nodeIds, requiredGateGroups)) {
        continue;
      }

      const candidateMetrics: CandidateRouteMetrics = {
        choiceCostM:
          startCandidate.selectionPenaltyM + result.choiceCostM + destinationCandidate.selectionPenaltyM,
        distanceM:
          startCandidate.selectionPenaltyM + result.distanceM + destinationCandidate.selectionPenaltyM,
        etaCostM:
          startCandidate.selectionPenaltyM + result.etaCostM + destinationCandidate.selectionPenaltyM,
        syntheticSegmentCount: result.syntheticSegmentCount,
      };

      if (!bestRoute || compareCandidateRouteMetrics(candidateMetrics, bestRoute.metrics) < 0) {
        bestRoute = {
          metrics: candidateMetrics,
          startCandidate,
          destinationCandidate,
          result,
        };
      }
    }
  }

  if (!bestRoute) {
    return null;
  }

  const routePath: [number, number][] = [];
  appendPath(routePath, bestRoute.startCandidate.pathPrefix);

  bestRoute.result.traversals.forEach((traversal) => {
    const traversalCoordinates = traversal.reverse
      ? [...traversal.edge.coordinates].reverse()
      : traversal.edge.coordinates;

    appendPath(routePath, traversalCoordinates);
  });

  appendPath(routePath, bestRoute.destinationCandidate.pathSuffix);

  const graphNodeIds = bestRoute.result.nodeIds;
  const path = routePath.length >= 2 ? routePath : [routePath[0], routePath[0]];
  const distanceM = routeDistanceMeters(path);
  const etaMin = etaMinutesFromEquivalentDistance(bestRoute.metrics.etaCostM);
  const steps = buildSteps(path);
  const startPrefixTail =
    bestRoute.startCandidate.pathPrefix.length > 0
      ? bestRoute.startCandidate.pathPrefix[bestRoute.startCandidate.pathPrefix.length - 1]
      : null;
  const destinationSuffixTail =
    bestRoute.destinationCandidate.pathSuffix.length > 0
      ? bestRoute.destinationCandidate.pathSuffix[bestRoute.destinationCandidate.pathSuffix.length - 1]
      : null;

  const nextTurnDistance =
    path.length > 1 ? Math.round(haversineMeters(path[0], path[1])) : 0;

  return {
    destination_id: destinationId,
    mode: 'walking',
    path,
    route_kind: 'graph',
    fallback_reason: null,
    distance_m: distanceM,
    eta_min: etaMin,
    eta_cost_m: Math.max(1, Math.round(bestRoute.metrics.etaCostM)),
    eta_baseline_min: etaMin,
    eta_live_min: etaMin,
    eta_mode: 'planned',
    steps,
    graph_node_ids: graphNodeIds,
    path_geojson: pathToGeoJsonLine(path),
    snapped_origin: bestRoute.startCandidate.snappedOrigin,
    remaining_path: path,
    remaining_distance_m: distanceM,
    eta_smoothed_min: etaMin,
    current_step_index: 0,
    distance_to_next_turn_m: nextTurnDistance,
    off_route_distance_m: Math.round(bestRoute.startCandidate.offRouteDistanceM),
    routing_mode: accessibilityMode,
    origin_access_point:
      bestRoute.startCandidate.originAccessPoint ?? startPrefixTail ?? path[0] ?? null,
    destination_access_point:
      bestRoute.destinationCandidate.destinationAccessPoint ??
      destinationSuffixTail ??
      path[path.length - 1] ??
      null,
    origin_access_hint_path: bestRoute.startCandidate.originAccessHintPath ?? null,
    warning_message: combineWarningMessages(
      warningMessage,
      bestRoute.startCandidate.warningMessage,
      bestRoute.destinationCandidate.warningMessage
    ),
  };
};

const fallbackRoutePreview = (
  origin: [number, number],
  destination: [number, number],
  destinationId: string,
  accessibilityMode: RouteAccessibilityMode,
  warningMessage?: string
): RoutePreview => {
  const path: [number, number][] = [origin, destination];
  const distance = routeDistanceMeters(path);
  const etaMin = etaMinutesFromEquivalentDistance(distance);

  return {
    destination_id: destinationId,
    mode: 'walking',
    path,
    route_kind: 'fallback_direct',
    fallback_reason: warningMessage ?? null,
    distance_m: distance,
    eta_min: etaMin,
    eta_cost_m: distance,
    eta_baseline_min: etaMin,
    eta_live_min: etaMin,
    eta_mode: 'planned',
    steps: [],
    graph_node_ids: [],
    path_geojson: pathToGeoJsonLine(path),
    snapped_origin: origin,
    remaining_path: path,
    remaining_distance_m: distance,
    eta_smoothed_min: etaMin,
    current_step_index: 0,
    distance_to_next_turn_m: 0,
    off_route_distance_m: 0,
    routing_mode: accessibilityMode,
    origin_access_point: origin,
    destination_access_point: destination,
    origin_access_hint_path: null,
    warning_message: warningMessage,
  };
};

const unavailableRoutePreview = (
  origin: [number, number],
  destinationId: string,
  accessibilityMode: RouteAccessibilityMode,
  warningMessage: string
): RoutePreview => {
  const path: [number, number][] = [origin, origin];

  return {
    destination_id: destinationId,
    mode: 'walking',
    path,
    route_kind: 'fallback_direct',
    fallback_reason: warningMessage,
    distance_m: 0,
    eta_min: 0,
    eta_cost_m: 0,
    eta_baseline_min: 0,
    eta_live_min: 0,
    eta_mode: 'planned',
    steps: [],
    graph_node_ids: [],
    path_geojson: pathToGeoJsonLine(path),
    snapped_origin: origin,
    remaining_path: path,
    remaining_distance_m: 0,
    eta_smoothed_min: 0,
    current_step_index: 0,
    distance_to_next_turn_m: 0,
    off_route_distance_m: 0,
    routing_mode: accessibilityMode,
    origin_access_point: origin,
    destination_access_point: origin,
    origin_access_hint_path: null,
    warning_message: warningMessage,
    arrival_eligible: false,
  };
};

export const buildCampusRoutePreview = ({
  origin,
  originLocationId,
  destination,
  destinationId,
  graph,
  accessibilityMode,
  locations,
  projectionIndex,
}: BuildCampusRoutePreviewOptions): RoutePreview => {
  const destinationFeature = findLocationFeatureById(locations ?? null, destinationId);
  const destinationAccessMode = resolveRoutingAccessMode(destinationFeature);
  const destinationIsOpenArea =
    destinationAccessMode === 'open_area' ||
    (destinationAccessMode !== 'entrance' && isOpenAreaFeature(destinationFeature));

  if (
    destinationFeature &&
    !isBoundaryFeature(destinationFeature) &&
    featureContainsPoint(destinationFeature, toMapPoint(origin))
  ) {
    return buildArrivedRoutePreview(
      origin,
      destinationId,
      accessibilityMode,
      destinationIsOpenArea
        ? "You're already at this destination."
        : "You're already inside this building."
    );
  }

  if (!graph || graph.edges.length === 0) {
    return fallbackRoutePreview(
      origin,
      destination,
      destinationId,
      accessibilityMode,
      'Walkway graph unavailable. Showing direct path.'
    );
  }

  const compoundGateRequirement = resolveRequiredCompoundGateGroups({
    graph,
    locations,
    origin,
    destination,
  });
  const requiresCompoundGates = compoundGateRequirement.gateGroups.length > 0;

  if (compoundGateRequirement.missingCompoundIds.length > 0) {
    return unavailableRoutePreview(
      origin,
      destinationId,
      accessibilityMode,
      `Route unavailable: compound ${compoundGateRequirement.missingCompoundIds.join(', ')} needs an explicit gate.`
    );
  }

  const blockingStructureFeatures = collectBlockingStructureFeatures(locations ?? null);
  const blockedEdgeIds = collectBlockedSyntheticEdgeIds(graph, blockingStructureFeatures);
  const candidateEdges = graph.edges.filter((edge) => edgeUsableForRouting(edge, accessibilityMode, blockedEdgeIds));
  const effectiveOriginLocationId = resolveEffectiveOriginLocationId({
    graph,
    origin,
    originLocationId,
    locations,
  });
  const originFeature =
    effectiveOriginLocationId ? findLocationFeatureById(locations ?? null, effectiveOriginLocationId) : null;
  if (candidateEdges.length === 0) {
    return fallbackRoutePreview(
      origin,
      destination,
      destinationId,
      accessibilityMode,
      'No accessible walkway edges available for this profile.'
    );
  }

  const resolvedDestination = resolveDestinationCandidates(
    graph,
    destinationId,
    destination,
    candidateEdges,
    blockingStructureFeatures,
    destinationFeature,
    projectionIndex
  );

  const destinationCandidateGroups = resolvedDestination.candidateGroups.filter((group) => group.length > 0);

  if (destinationCandidateGroups.length === 0) {
    return fallbackRoutePreview(
      origin,
      destination,
      destinationId,
      accessibilityMode,
      destinationIsOpenArea
        ? 'No open-area destination access found. Showing direct path.'
        : destinationFeature && supportsEnclosedBoundaryAccess(destinationFeature)
          ? 'No safe building access could be connected on the walkway graph. Showing direct path.'
        : 'No destination access nodes found. Showing direct path.'
    );
  }

  const projectedOriginStartCandidates = buildProjectedOriginStartCandidates(
    origin,
    candidateEdges,
    blockingStructureFeatures,
    projectionIndex
  );
  const entranceOriginStartCandidates = buildEntranceOriginStartCandidateTiers(
    graph,
    origin,
    effectiveOriginLocationId,
    candidateEdges,
    blockingStructureFeatures,
    projectionIndex
  );
  const startCandidateGroups: RouteStartCandidate[][] = [];
  const hasBuildingOrigin = Boolean(
    effectiveOriginLocationId && originFeature && supportsEnclosedBoundaryAccess(originFeature)
  );
  const buildingOriginCandidateGroups: RouteStartCandidate[][] = [];

  if (entranceOriginStartCandidates.connectedExplicitCandidates.length > 0) {
    buildingOriginCandidateGroups.push(entranceOriginStartCandidates.connectedExplicitCandidates);
  }

  if (entranceOriginStartCandidates.connectedInferredCandidates.length > 0) {
    buildingOriginCandidateGroups.push(entranceOriginStartCandidates.connectedInferredCandidates);
  }

  if (entranceOriginStartCandidates.projectedExplicitCandidates.length > 0) {
    buildingOriginCandidateGroups.push(entranceOriginStartCandidates.projectedExplicitCandidates);
  }

  if (entranceOriginStartCandidates.projectedInferredCandidates.length > 0) {
    buildingOriginCandidateGroups.push(entranceOriginStartCandidates.projectedInferredCandidates);
  }

  if (hasBuildingOrigin && effectiveOriginLocationId && originFeature) {
    const boundaryOriginStartCandidates = buildEnclosedBoundaryOriginStartCandidates({
      graph,
      origin,
      originFeature,
      originLocationId: effectiveOriginLocationId,
      candidateEdges,
      blockingStructureFeatures,
      projectionIndex,
    });

    if (boundaryOriginStartCandidates.length > 0) {
      buildingOriginCandidateGroups.push(boundaryOriginStartCandidates);
    }
  }

  startCandidateGroups.push(...buildingOriginCandidateGroups);

  // Only treat the user as inside the building if they are literally contained
  // within the polygon. If outside (but nearby), prefer direct edge projection
  // so we don't force-route through an entrance they haven't entered yet.
  const isActuallyInsideOriginBuilding =
    originFeature != null && featureContainsPoint(originFeature, toMapPoint(origin));

  if (hasBuildingOrigin && isActuallyInsideOriginBuilding) {
    if (
      buildingOriginCandidateGroups.length === 0 &&
      projectedOriginStartCandidates &&
      projectedOriginStartCandidates.length > 0
    ) {
      startCandidateGroups.push(projectedOriginStartCandidates);
    }
  } else if (projectedOriginStartCandidates && projectedOriginStartCandidates.length > 0) {
    startCandidateGroups.unshift(projectedOriginStartCandidates);
  }

  const hasAnyStartCandidates = startCandidateGroups.some((group) => group.length > 0);
  const rawOriginWarningMessage = hasAnyStartCandidates
    ? accessibilityMode === 'accessible'
      ? 'No safe accessible route found on walkway graph. Showing direct path.'
      : 'No safe connected route found on walkway graph. Showing direct path.'
    : hasBuildingOrigin
      ? 'Unable to find a safe exit or boundary access from the origin building.'
    : 'Unable to snap origin to safe walkway access.';

  for (const startCandidates of startCandidateGroups) {
    if (startCandidates.length === 0) {
      continue;
    }

    for (const destinationCandidates of destinationCandidateGroups) {
      if (destinationCandidates.length === 0) {
        continue;
      }

      const route = buildGraphRoutePreview({
        destinationId,
        destinationCandidates,
        graph,
        accessibilityMode,
        startCandidates,
        warningMessage: resolvedDestination.warningMessage,
        blockedEdgeIds,
        requiredGateGroups: compoundGateRequirement.gateGroups,
      });

      if (route) {
        return route;
      }
    }
  }

  if (requiresCompoundGates) {
    return unavailableRoutePreview(
      origin,
      destinationId,
      accessibilityMode,
      combineWarningMessages(
        'Route unavailable: no connected route was found through the required compound gate.',
        resolvedDestination.warningMessage
      ) ?? 'Route unavailable: no connected route was found through the required compound gate.'
    );
  }

  return fallbackRoutePreview(
    origin,
    destination,
    destinationId,
    accessibilityMode,
    combineWarningMessages(rawOriginWarningMessage, resolvedDestination.warningMessage)
  );
};

export const trackLocationOnRoute = (
  fullPath: [number, number][],
  location: [number, number],
  steps: RouteStep[] = buildSteps(fullPath)
): RouteTrackingInfo | null => {
  if (fullPath.length < 2) {
    return null;
  }

  const lengths = segmentLengths(fullPath);
  const cumulative = cumulativeLengths(lengths);

  let closest: SegmentProjection | null = null;
  let closestSegmentIndex = 0;

  for (let index = 0; index < fullPath.length - 1; index += 1) {
    const projection = projectToSegment(location, fullPath[index], fullPath[index + 1]);

    if (!closest || projection.distanceM < closest.distanceM) {
      closest = projection;
      closestSegmentIndex = index;
    }
  }

  if (!closest) {
    return null;
  }

  const currentSegmentLength = lengths[closestSegmentIndex] ?? 0;
  const alongDistance = cumulative[closestSegmentIndex] + currentSegmentLength * closest.t;
  const totalDistance = cumulative[cumulative.length - 1] ?? 0;
  const remainingDistance = Math.max(0, totalDistance - alongDistance);

  const stepIndex = steps.findIndex((step, index) => {
    const startDistanceM = step.start_distance_m ?? 0;
    const endDistanceM = step.end_distance_m ?? startDistanceM + step.distance_m;
    const isFinalStep = index === steps.length - 1;
    return alongDistance >= startDistanceM && (alongDistance < endDistanceM || isFinalStep);
  });
  const safeStepIndex =
    stepIndex === -1
      ? Math.max(0, steps.length - 1)
      : stepIndex;
  const activeStep = steps[safeStepIndex];
  const activeStepEndDistanceM = activeStep
    ? activeStep.end_distance_m ?? (activeStep.start_distance_m ?? 0) + activeStep.distance_m
    : alongDistance + Math.max(0, currentSegmentLength * (1 - closest.t));
  const distanceToNextTurn = Math.max(0, activeStepEndDistanceM - alongDistance);

  return {
    snapped_point: closest.point,
    off_route_distance_m: closest.distanceM,
    remaining_path: buildRemainingPath(fullPath, closestSegmentIndex, closest.point),
    remaining_distance_m: remainingDistance,
    progress_distance_m: Math.max(0, totalDistance - remainingDistance),
    current_step_index: safeStepIndex,
    distance_to_next_turn_m: distanceToNextTurn,
  };
};

export const enrichRoutePreviewWithTracking = (
  preview: RoutePreview,
  location: [number, number],
  options?: {
    nowMs?: number;
    userMotion?: UserMotion | null;
    etaState?: MotionEtaRuntimeState | null;
    etaSmoothedMin?: number;
  }
): {
  preview: RoutePreview;
  rawEtaMin: number;
  etaState: MotionEtaRuntimeState;
  userMotionPatch: Partial<UserMotion>;
} => {
  const tracking = trackLocationOnRoute(preview.path, location, preview.steps);
  const inputEtaState = options?.etaState ?? createMotionEtaRuntimeState();

  if (!tracking) {
    const fallbackEta = baselineEtaMinutes(preview);

    return {
      preview: {
        ...preview,
        eta_min: fallbackEta,
        eta_baseline_min: baselineEtaMinutes(preview),
        eta_live_min: preview.eta_live_min ?? fallbackEta,
        eta_mode: 'planned',
        eta_smoothed_min: options?.etaSmoothedMin ?? fallbackEta,
      },
      rawEtaMin: fallbackEta,
      etaState: inputEtaState,
      userMotionPatch: {
        speedMpsInferred: null,
        speedMpsEffective: null,
        state: 'idle',
      },
    };
  }

  const routeSignature = buildRouteSignature(preview);
  const nowMs = options?.nowMs ?? options?.userMotion?.timestampMs ?? Date.now();
  const currentEtaState =
    inputEtaState.routeSignature === routeSignature
      ? {
          ...inputEtaState,
          progressSamples: [...inputEtaState.progressSamples],
          speedSamplesMps: [...inputEtaState.speedSamplesMps],
        }
      : {
          ...createMotionEtaRuntimeState(),
          routeSignature,
        };

  const progressSamples = [
    ...currentEtaState.progressSamples,
    {
      timestampMs: nowMs,
      progressDistanceM: tracking.progress_distance_m,
    },
  ]
    .filter((sample) => nowMs - sample.timestampMs <= LIVE_ETA_PROGRESS_WINDOW_MS)
    .slice(-Math.max(LIVE_ETA_SPEED_SAMPLE_WINDOW + 1, LIVE_ETA_START_SAMPLE_COUNT + 1));

  const acceptedGpsSpeed = gpsSpeedAcceptedForEta(
    options?.userMotion?.speedMpsRaw,
    options?.userMotion?.accuracyM
  );
  const inferredSpeed = inferredSpeedFromProgressSamples(progressSamples);
  const movementSignal = (acceptedGpsSpeed ?? 0) >= LIVE_ETA_MOVEMENT_THRESHOLD_MPS ||
    (inferredSpeed ?? 0) >= LIVE_ETA_MOVEMENT_THRESHOLD_MPS;
  const progressGain = progressGainInWindow(progressSamples);
  const movingSampleStreak = movementSignal
    ? Math.min(currentEtaState.movingSampleStreak + 1, LIVE_ETA_START_SAMPLE_COUNT)
    : 0;
  const movementQualified =
    currentEtaState.movementQualified ||
    movingSampleStreak >= LIVE_ETA_START_SAMPLE_COUNT ||
    progressGain >= LIVE_ETA_PROGRESS_START_DISTANCE_M;

  const speedSamplesMps =
    acceptedGpsSpeed !== null || inferredSpeed !== null
      ? [
          ...currentEtaState.speedSamplesMps,
          acceptedGpsSpeed ?? inferredSpeed ?? 0,
        ].slice(-LIVE_ETA_SPEED_SAMPLE_WINDOW)
      : [...currentEtaState.speedSamplesMps];
  const effectiveSpeed = averageNumbers(speedSamplesMps);
  const baselineEta = baselineEtaMinutes(preview);
  const fallbackRemainingEta = baselineRemainingEtaMinutes(preview, tracking.remaining_distance_m);

  let etaMode: RouteEtaMode = 'planned';
  let motionState: UserMotion['state'] = movementSignal ? 'starting' : 'idle';
  let rawEta = baselineEta;
  let pauseStartedAtMs = currentEtaState.pauseStartedAtMs;
  let pauseEtaAnchorMin = currentEtaState.pauseEtaAnchorMin;

  if (!movementQualified) {
    rawEta = baselineEta;
  } else if (movementSignal && effectiveSpeed !== null && effectiveSpeed >= LIVE_ETA_MOVEMENT_THRESHOLD_MPS) {
    etaMode = 'live';
    motionState = 'moving';
    rawEta = etaMinutesFromSpeed(tracking.remaining_distance_m, effectiveSpeed);
    pauseStartedAtMs = null;
    pauseEtaAnchorMin = null;
  } else {
    etaMode = 'paused';
    motionState = 'paused';

    if (pauseStartedAtMs === null) {
      pauseStartedAtMs = nowMs;
      pauseEtaAnchorMin = currentEtaState.lastEtaMin ?? fallbackRemainingEta;
    }

    const pausedDurationMs = Math.max(0, nowMs - pauseStartedAtMs);
    const etaAnchor = pauseEtaAnchorMin ?? currentEtaState.lastEtaMin ?? fallbackRemainingEta;

    if (pausedDurationMs <= LIVE_ETA_PAUSE_HOLD_MS) {
      rawEta = etaAnchor;
    } else if (acceptedGpsSpeed === null && inferredSpeed === null && effectiveSpeed === null) {
      rawEta = fallbackRemainingEta;
    } else {
      rawEta = Math.max(
        fallbackRemainingEta,
        Math.round(etaAnchor + (pausedDurationMs - LIVE_ETA_PAUSE_HOLD_MS) / 60000)
      );
    }
  }

  const nextEtaState: MotionEtaRuntimeState = {
    routeSignature,
    progressSamples,
    speedSamplesMps,
    movingSampleStreak,
    movementQualified,
    pauseStartedAtMs,
    pauseEtaAnchorMin,
    lastEtaMin: rawEta,
  };

  const nextPreview: RoutePreview = {
    ...preview,
    snapped_origin: tracking.snapped_point,
    remaining_path: buildDisplayAnchoredRemainingPath(
      location,
      tracking.snapped_point,
      tracking.remaining_path,
      tracking.off_route_distance_m
    ),
    remaining_distance_m: Math.round(tracking.remaining_distance_m),
    eta_min: rawEta,
    eta_baseline_min: baselineEta,
    eta_live_min: etaMode === 'live' ? rawEta : preview.eta_live_min ?? rawEta,
    eta_mode: etaMode,
    eta_smoothed_min: options?.etaSmoothedMin ?? rawEta,
    current_step_index: tracking.current_step_index,
    distance_to_next_turn_m: Math.round(tracking.distance_to_next_turn_m),
    off_route_distance_m: Math.round(tracking.off_route_distance_m),
  };

  return {
    preview: nextPreview,
    rawEtaMin: rawEta,
    etaState: nextEtaState,
    userMotionPatch: {
      speedMpsInferred: inferredSpeed,
      speedMpsEffective: effectiveSpeed,
      state: motionState,
    },
  };
};
