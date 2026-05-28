import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { featureBoundaryDistanceToPointMeters, isBoundaryFeature } from './geoGeometry';
import type { CampusRoutingGraph, RoutingGraphNode } from './routingGraph';

const INFERRED_ENTRANCE_MAX_BOUNDARY_DISTANCE_M = 10;
const INFERRED_ENTRANCE_AMBIGUITY_MARGIN_M = 3;
const ENTRANCE_NAME_PATTERN = /\b(entrance|gate|entry|exit|door)\b/i;

type LocationFeature = Feature<Geometry, Record<string, unknown>>;
interface EntranceLocationMatch {
  locationId: string;
  boundaryDistanceM: number;
}

const resolveLocationFeatureId = (feature: LocationFeature): string | null => {
  if (typeof feature.id === 'string' && feature.id.trim().length > 0) {
    return feature.id.trim();
  }

  const properties = feature.properties ?? {};
  const propertyIdCandidates = [properties.id, properties['@id']];

  for (const candidate of propertyIdCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
};

const supportsEntranceInference = (feature: LocationFeature): boolean => {
  if (isBoundaryFeature(feature)) {
    return false;
  }

  return feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon';
};

const nodeHasGraphConnection = (graph: CampusRoutingGraph, nodeId: string): boolean => {
  return (graph.adjacency.get(nodeId)?.length ?? 0) > 0;
};

const nodeLooksLikeEntrance = (graph: CampusRoutingGraph, node: RoutingGraphNode): boolean => {
  if (!nodeHasGraphConnection(graph, node.id)) {
    return false;
  }

  if (node.kind === 'entrance' || node.locationId) {
    return true;
  }

  return ENTRANCE_NAME_PATTERN.test(node.name ?? '');
};

export const withInferredLocationEntrances = (
  graph: CampusRoutingGraph | null | undefined,
  locations: FeatureCollection<Geometry, Record<string, unknown>> | null | undefined
): CampusRoutingGraph | null => {
  if (!graph || !locations?.features?.length) {
    return graph ?? null;
  }

  const candidateLocations = locations.features
    .filter((feature): feature is LocationFeature => Boolean(feature && supportsEntranceInference(feature)))
    .map((feature) => ({
      id: resolveLocationFeatureId(feature),
      feature,
    }))
    .filter((entry): entry is { id: string; feature: LocationFeature } => Boolean(entry.id));

  if (candidateLocations.length === 0) {
    return graph;
  }

  const inferredEntranceNodeIdsByLocation = new Map<string, string[]>();

  for (const node of graph.nodes.values()) {
    if (!nodeLooksLikeEntrance(graph, node)) {
      continue;
    }

    // Respect explicit ownership from the dataset and only infer for unowned entrance-like nodes.
    if (node.locationId) {
      continue;
    }

    const point: [number, number] = [node.coordinates[1], node.coordinates[0]];
    const matches = candidateLocations
      .map<EntranceLocationMatch | null>(({ id, feature }) => {
        const boundaryDistanceM = featureBoundaryDistanceToPointMeters(feature, point);
        if (
          !Number.isFinite(boundaryDistanceM) ||
          boundaryDistanceM > INFERRED_ENTRANCE_MAX_BOUNDARY_DISTANCE_M
        ) {
          return null;
        }

        return {
          locationId: id,
          boundaryDistanceM,
        };
      })
      .filter((match): match is EntranceLocationMatch => Boolean(match))
      .sort((left, right) => left.boundaryDistanceM - right.boundaryDistanceM);

    const bestMatch = matches[0] ?? null;

    if (!bestMatch) {
      continue;
    }

    const nextBestMatch = matches[1] ?? null;
    if (
      nextBestMatch &&
      nextBestMatch.boundaryDistanceM - bestMatch.boundaryDistanceM <
        INFERRED_ENTRANCE_AMBIGUITY_MARGIN_M
    ) {
      continue;
    }

    const existing = inferredEntranceNodeIdsByLocation.get(bestMatch.locationId) ?? [];
    if (!existing.includes(node.id)) {
      inferredEntranceNodeIdsByLocation.set(bestMatch.locationId, [...existing, node.id]);
    }
  }

  if (inferredEntranceNodeIdsByLocation.size === 0) {
    return graph;
  }

  const entrancesByLocationId = new Map<string, string[]>();
  graph.entrancesByLocationId.forEach((nodeIds, locationId) => {
    entrancesByLocationId.set(locationId, [...nodeIds]);
  });

  inferredEntranceNodeIdsByLocation.forEach((nodeIds, locationId) => {
    const existing = entrancesByLocationId.get(locationId) ?? [];
    const merged = [...existing];

    nodeIds.forEach((nodeId) => {
      if (!merged.includes(nodeId)) {
        merged.push(nodeId);
      }
    });

    entrancesByLocationId.set(locationId, merged);
  });

  return {
    ...graph,
    entrancesByLocationId,
  };
};
