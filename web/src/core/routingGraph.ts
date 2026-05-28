import type { FeatureCollection, Geometry, Position } from 'geojson';
import { collectBlockingStructureFeatures, segmentCrossesBlockingStructures } from './geoGeometry';

const EARTH_RADIUS_M = 6371000;
const AUTO_NODE_PREFIX = 'node_auto_';
const ENTRANCE_CONNECTOR_MAX_DISTANCE_M = 24;
const WALKWAY_ENDPOINT_MERGE_DISTANCE_M = 3;
const INTERSECTION_SNAP_DISTANCE_M = 1;
const ENTRANCE_ATTACH_PREFER_NODE_DISTANCE_M = 3;
const SIMPLE_EDGE_ENDPOINT_TOLERANCE_M = 1;
const DUPLICATE_EDGE_ENDPOINT_SNAP_M = 2.25;

export type RoutingNodeKind = 'node' | 'entrance';
export type RoutingEdgeSourceKind = 'dataset' | 'dataset_split' | 'synthetic_bridge' | 'synthetic_connector';

export interface RoutingGraphNode {
  id: string;
  coordinates: [number, number];
  kind: RoutingNodeKind;
  locationId?: string;
  name?: string;
}

export interface RoutingGraphEdge {
  id: string;
  from: string;
  to: string;
  coordinates: [number, number][];
  distance_m: number;
  weight_m: number;
  accessible: boolean;
  stairs: boolean;
  ramp: boolean;
  elevator: boolean;
  sourceKind: RoutingEdgeSourceKind;
  sourceFeatureId?: string;
  locationId?: string;
}

export interface RoutingAdjacency {
  edgeId: string;
  neighborId: string;
  reverse: boolean;
  weight_m: number;
}

export interface RoutingWeightOverride {
  edgeId: string;
  effectiveWeightM: number;
}

export interface CampusRoutingGraph {
  nodes: Map<string, RoutingGraphNode>;
  edges: RoutingGraphEdge[];
  edgesById: Map<string, RoutingGraphEdge>;
  adjacency: Map<string, RoutingAdjacency[]>;
  entrancesByLocationId: Map<string, string[]>;
}

export interface RoutingGraphImportResult {
  graph: CampusRoutingGraph | null;
  errors: string[];
  warnings: string[];
}

export interface RoutingGraphImportOptions {
  undirected?: boolean;
  strict?: boolean;
  allowEmptyGraph?: boolean;
  locations?: FeatureCollection<Geometry, Record<string, unknown>> | null;
}

interface EdgeFlags {
  accessible: boolean;
  stairs: boolean;
  ramp: boolean;
  elevator: boolean;
}

interface PendingExplicitEdge extends EdgeFlags {
  id: string;
  from: string;
  to: string;
  coordinates: [number, number][];
  sourceIndex: number;
  sourceFeatureId?: string;
  locationId?: string;
}

interface PendingInferredLine extends EdgeFlags {
  idBase: string;
  coordinates: [number, number][];
  sourceIndex: number;
  sourceFeatureId?: string;
  locationId?: string;
}

interface SegmentProjection {
  point: [number, number];
  t: number;
  distanceM: number;
}

interface EdgeAttachmentCandidate {
  edge: RoutingGraphEdge;
  point: [number, number];
  distanceM: number;
}

interface SegmentIntersection {
  point: [number, number];
  tA: number;
  tB: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const haversineMeters = (from: [number, number], to: [number, number]): number => {
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;

  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(fromLat)) *
      Math.cos(toRadians(toLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const readString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
};

const readBoolean = (
  record: Record<string, unknown>,
  keys: string[],
  fallback = false
): boolean => {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value !== 0;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'yes', '1', 'y'].includes(normalized)) {
        return true;
      }
      if (['false', 'no', '0', 'n'].includes(normalized)) {
        return false;
      }
    }
  }

  return fallback;
};

const toLatLng = (position: Position): [number, number] | null => {
  if (!Array.isArray(position) || position.length < 2) {
    return null;
  }

  const lng = Number(position[0]);
  const lat = Number(position[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return [lat, lng];
};

const lineDistanceMeters = (coordinates: [number, number][]): number => {
  let distance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    distance += haversineMeters(coordinates[index - 1], coordinates[index]);
  }

  return Math.max(1, Math.round(distance));
};

const projectPointToSegment = (
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

  return {
    point: [projY / latFactor, projX / lngFactor],
    t: clampedT,
    distanceM: Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY)),
  };
};

const findNearestEdgeAttachment = (
  point: [number, number],
  edges: RoutingGraphEdge[]
): EdgeAttachmentCandidate | null => {
  let best: EdgeAttachmentCandidate | null = null;

  edges.forEach((edge) => {
    for (let index = 0; index < edge.coordinates.length - 1; index += 1) {
      const projection = projectPointToSegment(point, edge.coordinates[index], edge.coordinates[index + 1]);

      if (!best || projection.distanceM < best.distanceM) {
        best = {
          edge,
          point: projection.point,
          distanceM: projection.distanceM,
        };
      }
    }
  });

  return best;
};

const sanitizeEdgeSuffix = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9_]+/g, '_');
};

const toMapPoint = (coordinates: [number, number]): [number, number] => {
  return [coordinates[1], coordinates[0]];
};

const pathCrossesBlockingStructures = (
  coordinates: [number, number][],
  blockingStructureFeatures: FeatureCollection<Geometry, Record<string, unknown>>['features']
): boolean => {
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    if (
      segmentCrossesBlockingStructures(
        toMapPoint(coordinates[index]),
        toMapPoint(coordinates[index + 1]),
        blockingStructureFeatures
      )
    ) {
      return true;
    }
  }

  return false;
};

const buildNodePairKey = (left: string, right: string): string => {
  return left < right ? `${left}__${right}` : `${right}__${left}`;
};

const routingFlagKey = (edge: RoutingGraphEdge): string => {
  return [
    edge.accessible ? 'a1' : 'a0',
    edge.stairs ? 's1' : 's0',
    edge.ramp ? 'r1' : 'r0',
    edge.elevator ? 'e1' : 'e0',
    edge.locationId ?? '',
  ].join(':');
};

const edgeSourcePreference = (edge: RoutingGraphEdge): number => {
  switch (edge.sourceKind) {
    case 'dataset':
      return 0;
    case 'dataset_split':
      return 1;
    case 'synthetic_connector':
      return 2;
    case 'synthetic_bridge':
    default:
      return 3;
  }
};

const preferDuplicateEdge = (candidate: RoutingGraphEdge, existing: RoutingGraphEdge): RoutingGraphEdge => {
  const sourcePreferenceDelta = edgeSourcePreference(candidate) - edgeSourcePreference(existing);
  if (sourcePreferenceDelta !== 0) {
    return sourcePreferenceDelta < 0 ? candidate : existing;
  }

  if (candidate.distance_m !== existing.distance_m) {
    return candidate.distance_m < existing.distance_m ? candidate : existing;
  }

  return candidate.id.localeCompare(existing.id) < 0 ? candidate : existing;
};

const resolveDuplicateEndpointKey = (
  point: [number, number],
  endpoints: Array<{ key: string; point: [number, number] }>
): string => {
  const existing = endpoints.find((entry) => haversineMeters(entry.point, point) <= DUPLICATE_EDGE_ENDPOINT_SNAP_M);
  if (existing) {
    return existing.key;
  }

  const key = `dup_${endpoints.length + 1}`;
  endpoints.push({ key, point });
  return key;
};

const dedupeNearDuplicateEdges = (edges: RoutingGraphEdge[]): {
  edges: RoutingGraphEdge[];
  removedCount: number;
} => {
  const duplicateEndpoints: Array<{ key: string; point: [number, number] }> = [];
  const bestEdgeByKey = new Map<string, RoutingGraphEdge>();

  edges.forEach((edge) => {
    const startKey = resolveDuplicateEndpointKey(edge.coordinates[0], duplicateEndpoints);
    const endKey = resolveDuplicateEndpointKey(edge.coordinates[edge.coordinates.length - 1], duplicateEndpoints);

    if (startKey === endKey) {
      return;
    }

    const endpointKey = startKey < endKey ? `${startKey}__${endKey}` : `${endKey}__${startKey}`;
    const duplicateKey = `${endpointKey}__${routingFlagKey(edge)}`;
    const existing = bestEdgeByKey.get(duplicateKey);
    bestEdgeByKey.set(duplicateKey, existing ? preferDuplicateEdge(edge, existing) : edge);
  });

  const dedupedEdges = Array.from(bestEdgeByKey.values());
  return {
    edges: dedupedEdges,
    removedCount: edges.length - dedupedEdges.length,
  };
};

const findSegmentIntersection = (
  segmentAStart: [number, number],
  segmentAEnd: [number, number],
  segmentBStart: [number, number],
  segmentBEnd: [number, number]
): SegmentIntersection | null => {
  const referenceLat = (segmentAStart[0] + segmentAEnd[0] + segmentBStart[0] + segmentBEnd[0]) / 4;
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));

  const ax = segmentAStart[1] * lngFactor;
  const ay = segmentAStart[0] * latFactor;
  const bx = segmentAEnd[1] * lngFactor;
  const by = segmentAEnd[0] * latFactor;
  const cx = segmentBStart[1] * lngFactor;
  const cy = segmentBStart[0] * latFactor;
  const dx = segmentBEnd[1] * lngFactor;
  const dy = segmentBEnd[0] * latFactor;

  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const denominator = abx * cdy - aby * cdx;

  if (Math.abs(denominator) < Number.EPSILON) {
    return null;
  }

  const acx = cx - ax;
  const acy = cy - ay;
  const tA = (acx * cdy - acy * cdx) / denominator;
  const tB = (acx * aby - acy * abx) / denominator;

  if (tA < 0 || tA > 1 || tB < 0 || tB > 1) {
    return null;
  }

  const pointX = ax + abx * tA;
  const pointY = ay + aby * tA;

  return {
    point: [pointY / latFactor, pointX / lngFactor],
    tA,
    tB,
  };
};

const buildIncidentAccessibilityMap = (edges: RoutingGraphEdge[]): Map<string, boolean> => {
  const incidentAccessible = new Map<string, boolean>();

  edges.forEach((edge) => {
    const usableAccessible = edge.accessible && !edge.stairs;
    if (usableAccessible) {
      incidentAccessible.set(edge.from, true);
      incidentAccessible.set(edge.to, true);
      return;
    }

    if (!incidentAccessible.has(edge.from)) {
      incidentAccessible.set(edge.from, false);
    }
    if (!incidentAccessible.has(edge.to)) {
      incidentAccessible.set(edge.to, false);
    }
  });

  return incidentAccessible;
};

const findNearbyNodeId = (
  nodes: Map<string, RoutingGraphNode>,
  point: [number, number],
  maxDistanceM: number,
  predicate?: (node: RoutingGraphNode) => boolean
): string | null => {
  let bestId: string | null = null;
  let bestDistanceM = Number.POSITIVE_INFINITY;

  nodes.forEach((node, nodeId) => {
    if (predicate && !predicate(node)) {
      return;
    }

    const distanceM = haversineMeters(point, node.coordinates);
    if (distanceM > maxDistanceM) {
      return;
    }

    if (distanceM < bestDistanceM) {
      bestId = nodeId;
      bestDistanceM = distanceM;
    }
  });

  return bestId;
};

const expandEdgesToSimpleSegments = ({
  nodes,
  edges,
  seenEdgeIds,
  registerCoordinateNode,
}: {
  nodes: Map<string, RoutingGraphNode>;
  edges: RoutingGraphEdge[];
  seenEdgeIds: Set<string>;
  registerCoordinateNode: (coordinates: [number, number]) => string;
}): RoutingGraphEdge[] => {
  const expandedEdges: RoutingGraphEdge[] = [];

  edges.forEach((edge) => {
    if (edge.coordinates.length <= 2) {
      expandedEdges.push(edge);
      return;
    }

    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    const firstCoordinate = edge.coordinates[0];
    const lastCoordinate = edge.coordinates[edge.coordinates.length - 1];

    const canSplit =
      fromNode &&
      toNode &&
      haversineMeters(fromNode.coordinates, firstCoordinate) <= SIMPLE_EDGE_ENDPOINT_TOLERANCE_M &&
      haversineMeters(toNode.coordinates, lastCoordinate) <= SIMPLE_EDGE_ENDPOINT_TOLERANCE_M;

    if (!canSplit) {
      expandedEdges.push(edge);
      return;
    }

    const nodeSequence: string[] = [edge.from];

    for (let index = 1; index < edge.coordinates.length - 1; index += 1) {
      nodeSequence.push(registerCoordinateNode(edge.coordinates[index]));
    }

    nodeSequence.push(edge.to);

    for (let index = 0; index < nodeSequence.length - 1; index += 1) {
      const fromId = nodeSequence[index];
      const toId = nodeSequence[index + 1];
      const fromCoordinates = nodes.get(fromId)?.coordinates ?? edge.coordinates[index];
      const toCoordinates = nodes.get(toId)?.coordinates ?? edge.coordinates[index + 1];

      if (fromId === toId) {
        continue;
      }

      const coordinates: [number, number][] = [fromCoordinates, toCoordinates];
      const distance = lineDistanceMeters(coordinates);

      expandedEdges.push({
        ...edge,
        id: pickUniqueEdgeId(`${sanitizeEdgeSuffix(edge.id)}_segmented_${index + 1}`, seenEdgeIds),
        from: fromId,
        to: toId,
        coordinates,
        distance_m: distance,
        weight_m: distance,
        sourceKind: 'dataset_split',
      });
    }
  });

  return expandedEdges;
};

const splitIntersectingWalkwayEdges = ({
  nodes,
  edges,
  seenEdgeIds,
  registerCoordinateNode,
}: {
  nodes: Map<string, RoutingGraphNode>;
  edges: RoutingGraphEdge[];
  seenEdgeIds: Set<string>;
  registerCoordinateNode: (coordinates: [number, number]) => string;
}): RoutingGraphEdge[] => {
  const passthroughEdges: RoutingGraphEdge[] = [];
  const simpleEdges: RoutingGraphEdge[] = [];

  edges.forEach((edge) => {
    if (edge.coordinates.length === 2) {
      simpleEdges.push(edge);
      return;
    }

    passthroughEdges.push(edge);
  });

  interface EdgeCutPoint {
    t: number;
    nodeId: string;
    point: [number, number];
  }

  const cutsByEdgeId = new Map<string, EdgeCutPoint[]>();

  const addCut = (
    edge: RoutingGraphEdge,
    t: number,
    nodeId: string,
    point: [number, number]
  ): void => {
    const existing = cutsByEdgeId.get(edge.id) ?? [];
    const duplicate = existing.some((entry) => entry.nodeId === nodeId || Math.abs(entry.t - t) < 0.000001);
    if (duplicate) {
      return;
    }

    cutsByEdgeId.set(edge.id, [...existing, { t, nodeId, point }]);
  };

  const resolveIntersectionNodeId = (
    point: [number, number],
    edgeA: RoutingGraphEdge,
    edgeB: RoutingGraphEdge
  ): string => {
    const endpointIds = [edgeA.from, edgeA.to, edgeB.from, edgeB.to];
    for (const endpointId of endpointIds) {
      const endpointNode = nodes.get(endpointId);
      if (endpointNode && haversineMeters(point, endpointNode.coordinates) <= INTERSECTION_SNAP_DISTANCE_M) {
        return endpointId;
      }
    }

    const nearbyNodeId = findNearbyNodeId(
      nodes,
      point,
      INTERSECTION_SNAP_DISTANCE_M,
      (node) => node.kind === 'node'
    );
    if (nearbyNodeId) {
      return nearbyNodeId;
    }

    return registerCoordinateNode(point);
  };

  for (let leftIndex = 0; leftIndex < simpleEdges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < simpleEdges.length; rightIndex += 1) {
      const leftEdge = simpleEdges[leftIndex];
      const rightEdge = simpleEdges[rightIndex];

      const sharesEndpoint =
        leftEdge.from === rightEdge.from ||
        leftEdge.from === rightEdge.to ||
        leftEdge.to === rightEdge.from ||
        leftEdge.to === rightEdge.to;
      if (sharesEndpoint) {
        continue;
      }

      const intersection = findSegmentIntersection(
        leftEdge.coordinates[0],
        leftEdge.coordinates[1],
        rightEdge.coordinates[0],
        rightEdge.coordinates[1]
      );

      if (!intersection) {
        continue;
      }

      const intersectionNodeId = resolveIntersectionNodeId(intersection.point, leftEdge, rightEdge);
      const intersectionPoint = nodes.get(intersectionNodeId)?.coordinates ?? intersection.point;

      addCut(leftEdge, intersection.tA, intersectionNodeId, intersectionPoint);
      addCut(rightEdge, intersection.tB, intersectionNodeId, intersectionPoint);
    }
  }

  const splitEdges: RoutingGraphEdge[] = [...passthroughEdges];

  simpleEdges.forEach((edge) => {
    const startPoint = nodes.get(edge.from)?.coordinates ?? edge.coordinates[0];
    const endPoint = nodes.get(edge.to)?.coordinates ?? edge.coordinates[1];
    const rawCuts = cutsByEdgeId.get(edge.id);

    if (!rawCuts || rawCuts.length === 0) {
      splitEdges.push(edge);
      return;
    }

    const cutPoints: EdgeCutPoint[] = [
      { t: 0, nodeId: edge.from, point: startPoint },
      ...rawCuts,
      { t: 1, nodeId: edge.to, point: endPoint },
    ]
      .sort((left, right) => left.t - right.t)
      .filter((entry, index, list) => {
        if (index === 0) {
          return true;
        }

        const previous = list[index - 1];
        if (entry.nodeId === previous.nodeId) {
          return false;
        }

        return haversineMeters(entry.point, previous.point) > INTERSECTION_SNAP_DISTANCE_M;
      });

    if (cutPoints.length <= 2) {
      splitEdges.push(edge);
      return;
    }

    for (let index = 0; index < cutPoints.length - 1; index += 1) {
      const fromCut = cutPoints[index];
      const toCut = cutPoints[index + 1];

      if (fromCut.nodeId === toCut.nodeId) {
        continue;
      }

      const coordinates: [number, number][] = [fromCut.point, toCut.point];
      if (haversineMeters(coordinates[0], coordinates[1]) <= INTERSECTION_SNAP_DISTANCE_M) {
        continue;
      }

      const distance = lineDistanceMeters(coordinates);
      splitEdges.push({
        ...edge,
        id: pickUniqueEdgeId(`${sanitizeEdgeSuffix(edge.id)}_split_${index + 1}`, seenEdgeIds),
        from: fromCut.nodeId,
        to: toCut.nodeId,
        coordinates,
        distance_m: distance,
        weight_m: distance,
        sourceKind: edge.sourceKind === 'dataset' ? 'dataset_split' : edge.sourceKind,
      });
    }
  });

  return splitEdges;
};

const connectNearbyWalkwayNodes = ({
  nodes,
  edges,
  seenEdgeIds,
  blockingStructureFeatures,
}: {
  nodes: Map<string, RoutingGraphNode>;
  edges: RoutingGraphEdge[];
  seenEdgeIds: Set<string>;
  blockingStructureFeatures: FeatureCollection<Geometry, Record<string, unknown>>['features'];
}): void => {
  const usedNodeIds = new Set<string>();
  const pairKeys = new Set<string>();

  edges.forEach((edge) => {
    usedNodeIds.add(edge.from);
    usedNodeIds.add(edge.to);
    pairKeys.add(buildNodePairKey(edge.from, edge.to));
  });

  const walkwayNodeIds = Array.from(usedNodeIds).filter((nodeId) => {
    const node = nodes.get(nodeId);
    return Boolean(node && node.kind === 'node');
  });

  const incidentAccessible = buildIncidentAccessibilityMap(edges);

  for (let leftIndex = 0; leftIndex < walkwayNodeIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < walkwayNodeIds.length; rightIndex += 1) {
      const leftId = walkwayNodeIds[leftIndex];
      const rightId = walkwayNodeIds[rightIndex];
      const pairKey = buildNodePairKey(leftId, rightId);

      if (pairKeys.has(pairKey)) {
        continue;
      }

      const leftNode = nodes.get(leftId);
      const rightNode = nodes.get(rightId);
      if (!leftNode || !rightNode) {
        continue;
      }

      const distanceM = haversineMeters(leftNode.coordinates, rightNode.coordinates);
      if (distanceM <= 0 || distanceM > WALKWAY_ENDPOINT_MERGE_DISTANCE_M) {
        continue;
      }

      const bridgeCoordinates: [number, number][] = [leftNode.coordinates, rightNode.coordinates];
      if (pathCrossesBlockingStructures(bridgeCoordinates, blockingStructureFeatures)) {
        continue;
      }

      edges.push({
        id: pickUniqueEdgeId(`bridge_${sanitizeEdgeSuffix(leftId)}_${sanitizeEdgeSuffix(rightId)}`, seenEdgeIds),
        from: leftId,
        to: rightId,
        coordinates: bridgeCoordinates,
        distance_m: Math.max(1, Math.round(distanceM)),
        weight_m: Math.max(1, Math.round(distanceM)),
        accessible: Boolean((incidentAccessible.get(leftId) ?? false) && (incidentAccessible.get(rightId) ?? false)),
        stairs: false,
        ramp: false,
        elevator: false,
        sourceKind: 'synthetic_bridge',
      });

      pairKeys.add(pairKey);
    }
  }
};

const connectIsolatedEntranceNodes = ({
  nodes,
  edges,
  seenEdgeIds,
  warnings,
  blockingStructureFeatures,
}: {
  nodes: Map<string, RoutingGraphNode>;
  edges: RoutingGraphEdge[];
  seenEdgeIds: Set<string>;
  warnings: string[];
  blockingStructureFeatures: FeatureCollection<Geometry, Record<string, unknown>>['features'];
}): void => {
  const connectedNodeIds = new Set<string>();
  const incidentAccessible = buildIncidentAccessibilityMap(edges);

  edges.forEach((edge) => {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  });

  nodes.forEach((node) => {
    if (node.kind !== 'entrance' || connectedNodeIds.has(node.id)) {
      return;
    }

    const nearbyWalkwayNodeId = findNearbyNodeId(
      nodes,
      node.coordinates,
      ENTRANCE_ATTACH_PREFER_NODE_DISTANCE_M,
      (candidate) => candidate.kind === 'node' && connectedNodeIds.has(candidate.id)
    );

    let attachNode: RoutingGraphNode | null = null;
    let attachmentDistanceM = Number.POSITIVE_INFINITY;
    let connectorAccessible = true;

    if (nearbyWalkwayNodeId) {
      attachNode = nodes.get(nearbyWalkwayNodeId) ?? null;
      attachmentDistanceM = attachNode ? haversineMeters(node.coordinates, attachNode.coordinates) : Number.POSITIVE_INFINITY;
      connectorAccessible = attachNode ? Boolean(incidentAccessible.get(attachNode.id) ?? true) : true;
    } else {
      const attachment = findNearestEdgeAttachment(node.coordinates, edges);
      if (!attachment || attachment.distanceM > ENTRANCE_CONNECTOR_MAX_DISTANCE_M) {
        warnings.push(
          `Entrance node '${node.id}' for location '${node.locationId ?? node.id}' is not connected to a walkway segment within ${ENTRANCE_CONNECTOR_MAX_DISTANCE_M}m.`
        );
        return;
      }

      const fromNode = nodes.get(attachment.edge.from);
      const toNode = nodes.get(attachment.edge.to);

      if (!fromNode || !toNode) {
        warnings.push(
          `Entrance node '${node.id}' for location '${node.locationId ?? node.id}' could not be connected because its nearest edge is invalid.`
        );
        return;
      }

      attachNode =
        haversineMeters(node.coordinates, fromNode.coordinates) <= haversineMeters(node.coordinates, toNode.coordinates)
          ? fromNode
          : toNode;
      attachmentDistanceM = attachment.distanceM;
      connectorAccessible = attachment.edge.accessible;
    }

    if (!attachNode) {
      return;
    }

    const connectorCoordinates: [number, number][] = [node.coordinates, attachNode.coordinates];
    if (pathCrossesBlockingStructures(connectorCoordinates, blockingStructureFeatures)) {
      warnings.push(
        `Entrance node '${node.id}' for location '${node.locationId ?? node.id}' could not be auto-connected without crossing a blocking structure.`
      );
      return;
    }

    const connectorDistance = lineDistanceMeters(connectorCoordinates);

    edges.push({
      id: pickUniqueEdgeId(`connector_${sanitizeEdgeSuffix(node.id)}`, seenEdgeIds),
      from: node.id,
      to: attachNode.id,
      coordinates: connectorCoordinates,
      distance_m: connectorDistance,
      weight_m: connectorDistance,
      accessible: connectorAccessible,
      stairs: false,
      ramp: false,
      elevator: false,
      sourceKind: 'synthetic_connector',
      locationId: node.locationId,
    });

    connectedNodeIds.add(node.id);
    connectedNodeIds.add(attachNode.id);

    warnings.push(
      `Entrance node '${node.id}' for location '${node.locationId ?? node.id}' was auto-connected to walkway node '${attachNode.id}' (${Math.round(attachmentDistanceM)}m from the nearest segment).`
    );
  });
};

const isFeatureCollection = (
  input: unknown
): input is FeatureCollection<Geometry, Record<string, unknown>> => {
  const record = asRecord(input);
  if (!record || record.type !== 'FeatureCollection' || !Array.isArray(record.features)) {
    return false;
  }

  return true;
};

const normalizeNodeKind = (kindRaw: string | null, locationId: string | null): RoutingNodeKind => {
  if (kindRaw) {
    const normalized = kindRaw.toLowerCase();
    if (normalized === 'entrance' || normalized === 'gate') {
      return 'entrance';
    }
    if (normalized === 'node') {
      return 'node';
    }
  }

  return locationId ? 'entrance' : 'node';
};

const coordinateKey = (coordinates: [number, number]): string => {
  return `${coordinates[0].toFixed(7)},${coordinates[1].toFixed(7)}`;
};

const inferEdgeFlags = (record: Record<string, unknown>): EdgeFlags => {
  const highway = readString(record, ['highway'])?.toLowerCase();
  const wheelchairTag = readString(record, ['wheelchair', 'wheelchair_access']);
  const wheelchair = wheelchairTag?.toLowerCase();

  const wheelchairAccessible =
    wheelchair && ['yes', 'designated', 'limited', 'permissive'].includes(wheelchair)
      ? true
      : wheelchair === 'no'
        ? false
        : null;

  const stairs =
    readBoolean(record, ['stairs', 'has_stairs'], false) ||
    highway === 'steps' ||
    highway === 'stairway';

  const ramp = readBoolean(record, ['ramp', 'has_ramp'], false);
  const elevator =
    readBoolean(record, ['elevator', 'lift', 'has_elevator'], false) ||
    highway === 'elevator';

  const accessible =
    readBoolean(record, ['accessible', 'is_accessible'], wheelchairAccessible ?? !stairs) &&
    wheelchair !== 'no';

  return {
    accessible,
    stairs,
    ramp,
    elevator,
  };
};

const pickUniqueEdgeId = (baseId: string, seenEdgeIds: Set<string>): string => {
  let suffix = 1;
  let candidate = baseId;

  while (seenEdgeIds.has(candidate)) {
    suffix += 1;
    candidate = `${baseId}_${suffix}`;
  }

  seenEdgeIds.add(candidate);
  return candidate;
};

export const importRoutingGraph = (
  input: unknown,
  options: RoutingGraphImportOptions = {}
): RoutingGraphImportResult => {
  const undirected = options.undirected ?? true;
  const strict = options.strict ?? true;
  const allowEmptyGraph = options.allowEmptyGraph === true;

  const errors: string[] = [];
  const warnings: string[] = [];
  const blockingStructureFeatures = collectBlockingStructureFeatures(options.locations ?? null);

  if (!isFeatureCollection(input)) {
    return {
      graph: null,
      errors: ['Routing data must be a GeoJSON FeatureCollection.'],
      warnings,
    };
  }

  const collection = input as FeatureCollection<Geometry, Record<string, unknown>>;
  const nodes = new Map<string, RoutingGraphNode>();
  const nodeIdByCoordinate = new Map<string, string>();
  const pendingExplicitEdges: PendingExplicitEdge[] = [];
  const pendingInferredLines: PendingInferredLine[] = [];
  const seenEdgeIds = new Set<string>();

  let autoNodeIndex = 1;

  const registerCoordinateNode = (coordinates: [number, number]): string => {
    const key = coordinateKey(coordinates);
    const existing = nodeIdByCoordinate.get(key);

    if (existing) {
      return existing;
    }

    let nodeId = `${AUTO_NODE_PREFIX}${autoNodeIndex}`;
    while (nodes.has(nodeId)) {
      autoNodeIndex += 1;
      nodeId = `${AUTO_NODE_PREFIX}${autoNodeIndex}`;
    }

    nodes.set(nodeId, {
      id: nodeId,
      coordinates,
      kind: 'node',
    });

    nodeIdByCoordinate.set(key, nodeId);
    autoNodeIndex += 1;

    return nodeId;
  };

  collection.features.forEach((feature, index) => {
    const properties = asRecord(feature.properties) ?? {};

    if (!feature.geometry) {
      warnings.push(`Feature at index ${index} has no geometry and was skipped.`);
      return;
    }

    if (feature.geometry.type === 'Point') {
      const coordinates = toLatLng(feature.geometry.coordinates as Position);

      if (!coordinates) {
        warnings.push(`Point feature at index ${index} has invalid coordinates and was skipped.`);
        return;
      }

      const nodeId =
        readString(properties, ['node_id', 'nodeId', 'id']) ??
        (typeof feature.id === 'string' ? feature.id : null);

      if (!nodeId) {
        warnings.push(`Point feature at index ${index} is missing node_id and was skipped.`);
        return;
      }

      if (nodes.has(nodeId)) {
        errors.push(`Duplicate node id '${nodeId}' found.`);
        return;
      }

      const kindRaw = readString(properties, ['kind', 'node_type', 'type']);
      const locationId = readString(properties, ['fence_id', 'fenceId', 'location_id', 'locationId', 'building_id']);
      const kind = normalizeNodeKind(kindRaw, locationId);

      nodes.set(nodeId, {
        id: nodeId,
        coordinates,
        kind,
        locationId: locationId ?? undefined,
        name: readString(properties, ['name', 'label']) ?? undefined,
      });

      const key = coordinateKey(coordinates);
      if (!nodeIdByCoordinate.has(key)) {
        nodeIdByCoordinate.set(key, nodeId);
      }

      if (kind === 'entrance' && !locationId) {
        warnings.push(`Entrance node '${nodeId}' has no location_id mapping.`);
      }

      return;
    }

    if (feature.geometry.type === 'LineString') {
      const lineCoordinates = (feature.geometry.coordinates as Position[])
        .map((position) => toLatLng(position))
        .filter((point): point is [number, number] => Boolean(point));

      if (lineCoordinates.length < 2) {
        errors.push(`LineString edge at index ${index} has fewer than 2 valid coordinates.`);
        return;
      }

      const edgeFlags = inferEdgeFlags(properties);
      const edgeId =
        readString(properties, ['edge_id', 'edgeId', 'id', '@id']) ??
        (typeof feature.id === 'string' ? feature.id : null) ??
        `edge_${index + 1}`;

      const fromId = readString(properties, ['from', 'from_id', 'from_node', 'source']);
      const toId = readString(properties, ['to', 'to_id', 'to_node', 'target']);

      if (fromId && toId) {
        if (seenEdgeIds.has(edgeId)) {
          errors.push(`Duplicate edge id '${edgeId}' found.`);
          return;
        }

        seenEdgeIds.add(edgeId);

        pendingExplicitEdges.push({
          id: edgeId,
          from: fromId,
          to: toId,
          coordinates: lineCoordinates,
          sourceIndex: index,
          sourceFeatureId:
            (typeof feature.id === 'string' && feature.id.trim().length > 0 ? feature.id.trim() : edgeId),
          locationId: readString(properties, ['location_id', 'locationId', 'building_id']) ?? undefined,
          ...edgeFlags,
        });

        return;
      }

      const hasHighwayTag = typeof properties.highway === 'string';
      const kindTag = readString(properties, ['kind'])?.toLowerCase();
      const edgeLike = hasHighwayTag || kindTag === 'edge';

      if (!edgeLike) {
        warnings.push(
          `LineString feature '${edgeId}' at index ${index} has no from/to and no highway/kind=edge tag. Skipped.`
        );
        return;
      }

      pendingInferredLines.push({
        idBase: edgeId,
        coordinates: lineCoordinates,
        sourceIndex: index,
        sourceFeatureId:
          (typeof feature.id === 'string' && feature.id.trim().length > 0 ? feature.id.trim() : edgeId),
        locationId: readString(properties, ['location_id', 'locationId', 'building_id']) ?? undefined,
        ...edgeFlags,
      });
    }
  });

  const edges: RoutingGraphEdge[] = [];

  pendingExplicitEdges.forEach((pendingEdge) => {
    if (!nodes.has(pendingEdge.from) || !nodes.has(pendingEdge.to)) {
      errors.push(
        `Edge '${pendingEdge.id}' has dangling endpoint(s): from='${pendingEdge.from}', to='${pendingEdge.to}' (feature index ${pendingEdge.sourceIndex}).`
      );
      return;
    }

    if (pendingEdge.from === pendingEdge.to) {
      errors.push(`Edge '${pendingEdge.id}' has identical from/to node '${pendingEdge.from}'.`);
      return;
    }

    const distance = lineDistanceMeters(pendingEdge.coordinates);

    edges.push({
      id: pendingEdge.id,
      from: pendingEdge.from,
      to: pendingEdge.to,
      coordinates: pendingEdge.coordinates,
      distance_m: distance,
      weight_m: distance,
      accessible: pendingEdge.accessible,
      stairs: pendingEdge.stairs,
      ramp: pendingEdge.ramp,
      elevator: pendingEdge.elevator,
      sourceKind: 'dataset',
      sourceFeatureId: pendingEdge.sourceFeatureId,
      locationId: pendingEdge.locationId,
    });
  });

  pendingInferredLines.forEach((line) => {
    for (let segmentIndex = 0; segmentIndex < line.coordinates.length - 1; segmentIndex += 1) {
      const fromCoordinates = line.coordinates[segmentIndex];
      const toCoordinates = line.coordinates[segmentIndex + 1];

      const fromId = registerCoordinateNode(fromCoordinates);
      const toId = registerCoordinateNode(toCoordinates);

      if (fromId === toId) {
        continue;
      }

      const edgeId = pickUniqueEdgeId(`${line.idBase}_seg_${segmentIndex + 1}`, seenEdgeIds);
      const segmentCoordinates: [number, number][] = [fromCoordinates, toCoordinates];
      const distance = lineDistanceMeters(segmentCoordinates);

      edges.push({
        id: edgeId,
        from: fromId,
        to: toId,
        coordinates: segmentCoordinates,
        distance_m: distance,
        weight_m: distance,
        accessible: line.accessible,
        stairs: line.stairs,
        ramp: line.ramp,
        elevator: line.elevator,
        sourceKind: 'dataset',
        sourceFeatureId: line.sourceFeatureId,
        locationId: line.locationId,
      });
    }
  });

  const expandedEdges = expandEdgesToSimpleSegments({
    nodes,
    edges,
    seenEdgeIds,
    registerCoordinateNode,
  });
  edges.length = 0;
  edges.push(...expandedEdges);

  const splitEdges = splitIntersectingWalkwayEdges({
    nodes,
    edges,
    seenEdgeIds,
    registerCoordinateNode,
  });
  edges.length = 0;
  edges.push(...splitEdges);

  const dedupedResult = dedupeNearDuplicateEdges(edges);
  if (dedupedResult.removedCount > 0) {
    warnings.push(
      `Collapsed ${dedupedResult.removedCount} near-duplicate routing edge segment${dedupedResult.removedCount === 1 ? '' : 's'} before route search.`
    );
    edges.length = 0;
    edges.push(...dedupedResult.edges);
  }

  connectNearbyWalkwayNodes({
    nodes,
    edges,
    seenEdgeIds,
    blockingStructureFeatures,
  });

  connectIsolatedEntranceNodes({
    nodes,
    edges,
    seenEdgeIds,
    warnings,
    blockingStructureFeatures,
  });

  if (nodes.size === 0 && !allowEmptyGraph) {
    errors.push('Routing graph has no nodes.');
  }

  if (edges.length === 0 && !allowEmptyGraph) {
    errors.push('Routing graph has no edges.');
  }

  if (strict && errors.length > 0) {
    return {
      graph: null,
      errors,
      warnings,
    };
  }

  const edgesById = new Map<string, RoutingGraphEdge>();
  const adjacency = new Map<string, RoutingAdjacency[]>();

  nodes.forEach((_node, nodeId) => {
    adjacency.set(nodeId, []);
  });

  edges.forEach((edge) => {
    edgesById.set(edge.id, edge);

    adjacency.get(edge.from)?.push({
      edgeId: edge.id,
      neighborId: edge.to,
      reverse: false,
      weight_m: edge.weight_m,
    });

    if (undirected) {
      adjacency.get(edge.to)?.push({
        edgeId: edge.id,
        neighborId: edge.from,
        reverse: true,
        weight_m: edge.weight_m,
      });
    }
  });

  const entrancesByLocationId = new Map<string, string[]>();

  nodes.forEach((node) => {
    if (node.kind !== 'entrance' || !node.locationId) {
      return;
    }

    const existing = entrancesByLocationId.get(node.locationId) ?? [];
    entrancesByLocationId.set(node.locationId, [...existing, node.id]);
  });

  return {
    graph: {
      nodes,
      edges,
      edgesById,
      adjacency,
      entrancesByLocationId,
    },
    errors,
    warnings,
  };
};

export const validateRoutingGraph = (
  input: unknown,
  options: RoutingGraphImportOptions = {}
): RoutingGraphImportResult => {
  return importRoutingGraph(input, options);
};

export const isEmptyRoutingGraph = (
  graph: CampusRoutingGraph | null | undefined
): graph is CampusRoutingGraph => {
  if (!graph) {
    return false;
  }

  return graph.nodes.size === 0 && graph.edges.length === 0;
};

export const applyRoutingWeightOverrides = (
  graph: CampusRoutingGraph | null,
  overrides: RoutingWeightOverride[]
): CampusRoutingGraph | null => {
  if (!graph) {
    return null;
  }

  const overrideByEdgeId = new Map(
    (Array.isArray(overrides) ? overrides : [])
      .filter((entry) => typeof entry?.edgeId === 'string' && Number.isFinite(entry?.effectiveWeightM))
      .map((entry) => [entry.edgeId, Math.max(1, Math.round(entry.effectiveWeightM))])
  );

  if (overrideByEdgeId.size === 0) {
    return graph;
  }

  const edges = graph.edges.map((edge) => ({
    ...edge,
    weight_m: overrideByEdgeId.get(edge.id) ?? edge.weight_m,
  }));

  const edgesById = new Map<string, RoutingGraphEdge>();
  edges.forEach((edge) => {
    edgesById.set(edge.id, edge);
  });

  const adjacency = new Map<string, RoutingAdjacency[]>();
  graph.adjacency.forEach((entries, nodeId) => {
    adjacency.set(
      nodeId,
      entries.map((entry) => ({
        ...entry,
        weight_m: overrideByEdgeId.get(entry.edgeId) ?? entry.weight_m,
      }))
    );
  });

  return {
    nodes: graph.nodes,
    edges,
    edgesById,
    adjacency,
    entrancesByLocationId: graph.entrancesByLocationId,
  };
};
