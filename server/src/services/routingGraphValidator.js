const EARTH_RADIUS_M = 6371000;
const AUTO_NODE_PREFIX = 'node_auto_';
const ENTRANCE_CONNECTOR_MAX_DISTANCE_M = 24;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const haversineMeters = (from, to) => {
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;

  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const asRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value;
};

const readString = (record, keys) => {
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

const readBoolean = (record, keys, fallback = false) => {
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

const toLatLng = (position) => {
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

const lineDistanceMeters = (coordinates) => {
  let distance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    distance += haversineMeters(coordinates[index - 1], coordinates[index]);
  }

  return Math.max(1, Math.round(distance));
};

const projectPointToSegment = (point, segmentStart, segmentEnd) => {
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

const findNearestEdgeAttachment = (point, edges) => {
  let best = null;

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

const sanitizeEdgeSuffix = (value) => {
  return value.replace(/[^a-zA-Z0-9_]+/g, '_');
};

const connectIsolatedEntranceNodes = ({ nodes, edges, seenEdgeIds, warnings }) => {
  const connectedNodeIds = new Set();

  edges.forEach((edge) => {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  });

  nodes.forEach((node) => {
    if (node.kind !== 'entrance' || connectedNodeIds.has(node.id)) {
      return;
    }

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

    const attachNode =
      haversineMeters(node.coordinates, fromNode.coordinates) <= haversineMeters(node.coordinates, toNode.coordinates)
        ? fromNode
        : toNode;

    const connectorCoordinates = [node.coordinates, attachNode.coordinates];
    const connectorDistance = lineDistanceMeters(connectorCoordinates);

    edges.push({
      id: pickUniqueEdgeId(`connector_${sanitizeEdgeSuffix(node.id)}`, seenEdgeIds),
      from: node.id,
      to: attachNode.id,
      coordinates: connectorCoordinates,
      distance_m: connectorDistance,
      weight_m: connectorDistance,
      accessible: attachment.edge.accessible,
      stairs: false,
      ramp: false,
      elevator: false,
    });

    connectedNodeIds.add(node.id);
    connectedNodeIds.add(attachNode.id);

    warnings.push(
      `Entrance node '${node.id}' for location '${node.locationId ?? node.id}' was auto-connected to walkway node '${attachNode.id}' (${Math.round(attachment.distanceM)}m from the nearest segment).`
    );
  });
};

const isFeatureCollection = (input) => {
  const record = asRecord(input);
  if (!record || record.type !== 'FeatureCollection' || !Array.isArray(record.features)) {
    return false;
  }

  return true;
};

const normalizeNodeKind = (kindRaw, locationId) => {
  if (kindRaw) {
    const normalized = kindRaw.toLowerCase();
    if (normalized === 'entrance') {
      return 'entrance';
    }
    if (normalized === 'node') {
      return 'node';
    }
  }

  return locationId ? 'entrance' : 'node';
};

const coordinateKey = (coordinates) => {
  return `${coordinates[0].toFixed(7)},${coordinates[1].toFixed(7)}`;
};

const inferEdgeFlags = (record) => {
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

const pickUniqueEdgeId = (baseId, seenEdgeIds) => {
  let suffix = 1;
  let candidate = baseId;

  while (seenEdgeIds.has(candidate)) {
    suffix += 1;
    candidate = `${baseId}_${suffix}`;
  }

  seenEdgeIds.add(candidate);
  return candidate;
};

export const importRoutingGraph = (input, options = {}) => {
  const undirected = options.undirected ?? true;
  const strict = options.strict ?? true;
  const allowEmptyGraph = options.allowEmptyGraph === true;

  const errors = [];
  const warnings = [];

  if (!isFeatureCollection(input)) {
    return {
      graph: null,
      errors: ['Routing data must be a GeoJSON FeatureCollection.'],
      warnings,
    };
  }

  const collection = input;
  const nodes = new Map();
  const nodeIdByCoordinate = new Map();
  const pendingExplicitEdges = [];
  const pendingInferredLines = [];
  const seenEdgeIds = new Set();

  let autoNodeIndex = 1;

  const registerCoordinateNode = (coordinates) => {
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
      const coordinates = toLatLng(feature.geometry.coordinates);

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

      const locationId = readString(properties, ['location_id', 'locationId', 'building_id']);
      const kind = normalizeNodeKind(readString(properties, ['kind', 'node_type', 'type']), locationId);

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
      const lineCoordinates = feature.geometry.coordinates
        .map((position) => toLatLng(position))
        .filter((point) => Boolean(point));

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
        ...edgeFlags,
      });
    }
  });

  const edges = [];

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
      const segmentCoordinates = [fromCoordinates, toCoordinates];
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
      });
    }
  });

  connectIsolatedEntranceNodes({
    nodes,
    edges,
    seenEdgeIds,
    warnings,
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

  const edgesById = new Map();
  const adjacency = new Map();

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

  const entrancesByLocationId = new Map();

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

export const validateRoutingGraph = (input, options = {}) => {
  return importRoutingGraph(input, options);
};
