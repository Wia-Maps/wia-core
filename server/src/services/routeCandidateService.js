import CandidateEdge from '../models/CandidateEdge.js';
import { bulkUpsertDatasetFeatures, getCurrentDataset } from './mapDatasetService.js';
import { logAdminActivity } from './adminActivityService.js';
import { importRoutingGraph } from './routingGraphValidator.js';
import {
  ROUTE_NODE_SNAP_THRESHOLD_M,
  asTrimmedString,
  cloneJson,
  coordinateToLatLng,
  haversineMeters,
  latLngToCoordinate,
  latLngsToLineString,
  lineDistanceMeters,
  lineStringToLatLngs,
  normalizeActor,
  resolveCampusId,
  simplifyLatLngPath,
} from './routeGeometry.js';
import { upsertRoutingWeightOverlay } from './routingWeightService.js';

const DEFAULT_ROUTE_PROPERTIES = {
  name: '',
  accessible: true,
  stairs: false,
  ramp: false,
  elevator: false,
};

const SNAP_THRESHOLD_M = ROUTE_NODE_SNAP_THRESHOLD_M;

const candidateSearchRegex = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

const buildRouteProperties = (payload) => {
  return {
    name: asTrimmedString(payload?.name ?? payload?.routeProperties?.name),
    accessible:
      typeof payload?.accessible === 'boolean'
        ? payload.accessible
        : typeof payload?.routeProperties?.accessible === 'boolean'
          ? payload.routeProperties.accessible
          : DEFAULT_ROUTE_PROPERTIES.accessible,
    stairs:
      typeof payload?.stairs === 'boolean'
        ? payload.stairs
        : typeof payload?.routeProperties?.stairs === 'boolean'
          ? payload.routeProperties.stairs
          : DEFAULT_ROUTE_PROPERTIES.stairs,
    ramp:
      typeof payload?.ramp === 'boolean'
        ? payload.ramp
        : typeof payload?.routeProperties?.ramp === 'boolean'
          ? payload.routeProperties.ramp
          : DEFAULT_ROUTE_PROPERTIES.ramp,
    elevator:
      typeof payload?.elevator === 'boolean'
        ? payload.elevator
        : typeof payload?.routeProperties?.elevator === 'boolean'
          ? payload.routeProperties.elevator
          : DEFAULT_ROUTE_PROPERTIES.elevator,
  };
};

const buildGeometryFromPayload = (payload) => {
  if (payload?.geometry) {
    const points = simplifyLatLngPath(lineStringToLatLngs(payload.geometry));
    return latLngsToLineString(points);
  }

  const polyline = Array.isArray(payload?.points) ? payload.points : [];
  if (polyline.length >= 2) {
    const latLngs = simplifyLatLngPath(
      polyline.map((point) => {
        const latitude = Number(point?.latitude ?? point?.lat);
        const longitude = Number(point?.longitude ?? point?.lng);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          throw new Error('Recording points must contain valid latitude/longitude pairs.');
        }

        return [latitude, longitude];
      })
    );
    return latLngsToLineString(latLngs);
  }

  throw new Error('A route geometry LineString or points array is required.');
};

const resolveExplicitRoutingNodes = (routingCollection) => {
  const graphResult = importRoutingGraph(routingCollection, { strict: false });
  const graph = graphResult.graph;

  if (!graph) {
    return [];
  }

  const explicitNodes = [];
  const explicitNodeIds = new Set(
    routingCollection.features
      .filter((feature) => feature?.geometry?.type === 'Point')
      .map((feature) => {
        if (typeof feature.id === 'string') {
          return feature.id.trim();
        }

        const nodeId = typeof feature?.properties?.node_id === 'string' ? feature.properties.node_id.trim() : '';
        return nodeId;
      })
      .filter(Boolean)
  );

  explicitNodeIds.forEach((nodeId) => {
    const node = graph.nodes.get(nodeId);
    if (node) {
      explicitNodes.push(node);
    }
  });

  return explicitNodes;
};

const findNearestNodeAttachment = (nodes, pointLatLng) => {
  let best = null;

  nodes.forEach((node) => {
    const distanceM = haversineMeters(pointLatLng, node.coordinates);
    if (!best || distanceM < best.distanceM) {
      best = {
        nodeId: node.id,
        locationId: node.locationId ?? null,
        coordinates: latLngToCoordinate(node.coordinates),
        snapped: distanceM <= SNAP_THRESHOLD_M,
        distanceM: Math.round(distanceM),
      };
    }
  });

  return (
    best ?? {
      nodeId: null,
      locationId: null,
      coordinates: latLngToCoordinate(pointLatLng),
      snapped: false,
      distanceM: 0,
    }
  );
};

const buildAnchorsForGeometry = async (campusId, geometry) => {
  const routingDataset = await getCurrentDataset('routing');
  const explicitNodes = resolveExplicitRoutingNodes(routingDataset.collection);
  const path = lineStringToLatLngs(geometry);
  const startPoint = path[0];
  const endPoint = path[path.length - 1];

  return {
    startAnchor: findNearestNodeAttachment(explicitNodes, startPoint),
    endAnchor: findNearestNodeAttachment(explicitNodes, endPoint),
    path,
  };
};

const serializeCandidateEdge = (candidate) => ({
  id: candidate._id?.toString?.() ?? candidate.id,
  campusId: candidate.campusId,
  title: candidate.title,
  status: candidate.status,
  source: candidate.source,
  analyticsKey: candidate.analyticsKey ?? null,
  geometry: cloneJson(candidate.geometry),
  startAnchor: cloneJson(candidate.startAnchor),
  endAnchor: cloneJson(candidate.endAnchor),
  routeProperties: cloneJson(candidate.routeProperties ?? DEFAULT_ROUTE_PROPERTIES),
  observedCount: candidate.observedCount,
  distinctSessionCount: candidate.distinctSessionCount,
  confidence: candidate.confidence,
  averageDistanceM: candidate.averageDistanceM,
  averageDurationS: candidate.averageDurationS,
  averageAccuracyM: candidate.averageAccuracyM,
  improvementDistanceM: candidate.improvementDistanceM,
  telemetrySourceIds: cloneJson(candidate.telemetrySourceIds ?? []),
  review: candidate.review
    ? {
        reviewedAt: candidate.review.reviewedAt ? new Date(candidate.review.reviewedAt).toISOString() : null,
        reviewedBy: cloneJson(candidate.review.reviewedBy ?? null),
        notes: candidate.review.notes ?? '',
        rejectionReason: candidate.review.rejectionReason ?? '',
      }
    : null,
  publish: candidate.publish
    ? {
        publishedAt: candidate.publish.publishedAt ? new Date(candidate.publish.publishedAt).toISOString() : null,
        publishedBy: cloneJson(candidate.publish.publishedBy ?? null),
        routingRevisionId: candidate.publish.routingRevisionId ?? null,
        featureIds: cloneJson(candidate.publish.featureIds ?? []),
        overlayVersion: candidate.publish.overlayVersion ?? null,
      }
    : null,
  metadata: cloneJson(candidate.metadata ?? null),
  createdAt: new Date(candidate.createdAt).toISOString(),
  updatedAt: new Date(candidate.updatedAt).toISOString(),
});

const normalizeCandidateCore = async (payload, defaults = {}) => {
  const source = asTrimmedString(payload?.source) || defaults.source || 'admin_recording';
  const status = asTrimmedString(payload?.status) || defaults.status || 'pending';
  const campusId = resolveCampusId(payload?.campusId ?? payload?.campus_id ?? defaults.campusId);
  const title = asTrimmedString(payload?.title) || asTrimmedString(payload?.name) || defaults.title || '';
  const geometry = buildGeometryFromPayload(payload);
  const anchors = await buildAnchorsForGeometry(campusId, geometry);
  const observedCount = Math.max(0, Number(payload?.observedCount ?? defaults.observedCount ?? 0) || 0);
  const distinctSessionCount = Math.max(
    0,
    Number(payload?.distinctSessionCount ?? defaults.distinctSessionCount ?? observedCount) || 0
  );

  return {
    campusId,
    title,
    source,
    status,
    geometry,
    startAnchor: anchors.startAnchor,
    endAnchor: anchors.endAnchor,
    routeProperties: {
      ...DEFAULT_ROUTE_PROPERTIES,
      ...(defaults.routeProperties ?? {}),
      ...buildRouteProperties(payload),
    },
    observedCount,
    distinctSessionCount,
    confidence: Math.max(0, Math.min(1, Number(payload?.confidence ?? defaults.confidence ?? 0) || 0)),
    averageDistanceM: Math.max(
      0,
      Number(payload?.averageDistanceM ?? defaults.averageDistanceM ?? lineDistanceMeters(anchors.path)) || 0
    ),
    averageDurationS: Math.max(0, Number(payload?.averageDurationS ?? defaults.averageDurationS ?? 0) || 0),
    averageAccuracyM: Math.max(0, Number(payload?.averageAccuracyM ?? defaults.averageAccuracyM ?? 0) || 0),
    improvementDistanceM: Number(payload?.improvementDistanceM ?? defaults.improvementDistanceM ?? 0) || 0,
    telemetrySourceIds: Array.isArray(payload?.telemetrySourceIds)
      ? payload.telemetrySourceIds.map((value) => asTrimmedString(value)).filter(Boolean)
      : defaults.telemetrySourceIds ?? [],
    metadata: {
      ...(defaults.metadata ?? {}),
      ...(payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {}),
    },
  };
};

const buildRoutingNodeFeature = (nodeId, coordinates, indexLabel) => ({
  type: 'Feature',
  id: nodeId,
  geometry: {
    type: 'Point',
    coordinates,
  },
  properties: {
    node_id: nodeId,
    kind: 'node',
    name: `Candidate ${indexLabel} node`,
  },
});

const buildRoutingEdgeFeature = ({
  featureId,
  geometry,
  fromNodeId,
  toNodeId,
  routeProperties,
  candidateId,
}) => ({
  type: 'Feature',
  id: featureId,
  geometry,
  properties: {
    edge_id: featureId,
    kind: 'edge',
    from: fromNodeId,
    to: toNodeId,
    highway: 'path',
    name: routeProperties.name || `Candidate route ${candidateId}`,
    accessible: routeProperties.accessible,
    stairs: routeProperties.stairs,
    ramp: routeProperties.ramp,
    elevator: routeProperties.elevator,
    candidate_id: candidateId,
  },
});

const buildApprovalFeatures = (candidate) => {
  const features = [];
  const featureIds = [];
  const path = lineStringToLatLngs(candidate.geometry);
  const updatedPath = [...path];

  let fromNodeId = candidate.startAnchor?.nodeId ?? null;
  if (!candidate.startAnchor?.snapped || !fromNodeId) {
    fromNodeId = `route_node_${Date.now()}_start`;
    const coordinates = latLngToCoordinate(path[0]);
    features.push(buildRoutingNodeFeature(fromNodeId, coordinates, 'start'));
    featureIds.push(fromNodeId);
  } else {
    const snappedLatLng = coordinateToLatLng(candidate.startAnchor.coordinates);
    if (snappedLatLng) {
      updatedPath[0] = snappedLatLng;
    }
  }

  let toNodeId = candidate.endAnchor?.nodeId ?? null;
  if (!candidate.endAnchor?.snapped || !toNodeId) {
    toNodeId = `route_node_${Date.now()}_end`;
    const coordinates = latLngToCoordinate(path[path.length - 1]);
    features.push(buildRoutingNodeFeature(toNodeId, coordinates, 'end'));
    featureIds.push(toNodeId);
  } else {
    const snappedLatLng = coordinateToLatLng(candidate.endAnchor.coordinates);
    if (snappedLatLng) {
      updatedPath[updatedPath.length - 1] = snappedLatLng;
    }
  }

  const edgeId = `route_edge_${Date.now()}`;
  const edgeGeometry = latLngsToLineString(updatedPath);
  features.push(
    buildRoutingEdgeFeature({
      featureId: edgeId,
      geometry: edgeGeometry,
      fromNodeId,
      toNodeId,
      routeProperties: candidate.routeProperties ?? DEFAULT_ROUTE_PROPERTIES,
      candidateId: candidate._id?.toString?.() ?? candidate.id,
    })
  );
  featureIds.push(edgeId);

  return {
    features,
    featureIds,
    edgeId,
    edgeGeometry,
  };
};

const buildInitialOverlayEntry = (candidate, edgeId) => {
  const baseDistanceM = Math.max(
    1,
    Math.round(candidate.averageDistanceM || 0) || lineDistanceMeters(lineStringToLatLngs(candidate.geometry))
  );
  const popularityBoost = Math.min(
    0.22,
    Math.max(0, (candidate.observedCount ?? 0) * 0.01 + (candidate.confidence ?? 0) * 0.08)
  );

  return {
    edgeId,
    baseDistanceM,
    popularityBoost,
    congestionPenalty: 0,
    popularityCount7d: Math.max(0, candidate.observedCount ?? 0),
    congestionCount15m: 0,
    source: 'candidate_approval',
  };
};

const resolveAnalyticsKey = (payload, defaults = {}) => {
  return (
    asTrimmedString(payload?.analyticsKey) ||
    asTrimmedString(payload?.metadata?.analyticsKey) ||
    asTrimmedString(payload?.metadata?.externalKey) ||
    asTrimmedString(defaults.analyticsKey) ||
    null
  );
};

const uniqueStrings = (values = []) => {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => asTrimmedString(value)).filter(Boolean))];
};

const weightedAverageMetric = (leftValue, leftWeight, rightValue, rightWeight) => {
  const safeLeftWeight = Math.max(0, Number(leftWeight) || 0);
  const safeRightWeight = Math.max(0, Number(rightWeight) || 0);
  const safeLeftValue = Math.max(0, Number(leftValue) || 0);
  const safeRightValue = Math.max(0, Number(rightValue) || 0);
  const totalWeight = safeLeftWeight + safeRightWeight;

  if (totalWeight <= 0) {
    return Math.max(safeLeftValue, safeRightValue);
  }

  return Math.round((safeLeftValue * safeLeftWeight + safeRightValue * safeRightWeight) / totalWeight);
};

const mergeArrayField = (left, right, limit = 200) => {
  return uniqueStrings([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]).slice(0, limit);
};

const mergeObjectArrayField = (left, right, limit = 50) => {
  const merged = [];
  const seen = new Set();

  [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].forEach((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }

    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(cloneJson(value));
  });

  return merged.slice(0, limit);
};

const normalizeCleanupIssueArray = (value) => {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => cloneJson(entry));
};

const mergeGeometryCleanupMetadata = (existingCleanup, nextCleanup) => {
  const existing =
    existingCleanup && typeof existingCleanup === 'object' && !Array.isArray(existingCleanup)
      ? existingCleanup
      : null;
  const next =
    nextCleanup && typeof nextCleanup === 'object' && !Array.isArray(nextCleanup)
      ? nextCleanup
      : null;

  if (!existing && !next) {
    return null;
  }

  const existingIssues = normalizeCleanupIssueArray(existing?.issues);
  const nextIssues = normalizeCleanupIssueArray(next?.issues);
  const nextIssueMap = new Map(nextIssues.map((issue) => [issue.id, issue]));
  const mergedIssues = nextIssues.map((issue) => {
    const persisted = existingIssues.find((existingIssue) => existingIssue.id === issue.id);
    if (!persisted || !persisted.status || persisted.status === 'pending') {
      return issue;
    }

    return {
      ...issue,
      status: persisted.status,
      source: persisted.source || issue.source,
      proposedGeometry: persisted.proposedGeometry ?? issue.proposedGeometry,
    };
  });

  existingIssues.forEach((issue) => {
    if (!issue?.id || nextIssueMap.has(issue.id) || issue.status === 'pending') {
      return;
    }

    mergedIssues.push(issue);
  });

  return {
    ...(existing ? cloneJson(existing) : {}),
    ...(next ? cloneJson(next) : {}),
    originalGeometry: next?.originalGeometry ?? existing?.originalGeometry ?? null,
    proposedGeometry: next?.proposedGeometry ?? existing?.proposedGeometry ?? null,
    issues: mergedIssues,
  };
};

const mergeAnalyticsMetadata = (existingMetadata, nextMetadata) => {
  const existing = existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata) ? existingMetadata : {};
  const next = nextMetadata && typeof nextMetadata === 'object' && !Array.isArray(nextMetadata) ? nextMetadata : {};

  return {
    ...existing,
    ...next,
    sessionIds: mergeArrayField(existing.sessionIds, next.sessionIds),
    deviceIds: mergeArrayField(existing.deviceIds, next.deviceIds),
    dayKeys: mergeArrayField(existing.dayKeys, next.dayKeys),
    routeSignatures: mergeArrayField(existing.routeSignatures, next.routeSignatures),
    edgeSequenceSignatures: mergeArrayField(existing.edgeSequenceSignatures, next.edgeSequenceSignatures),
    anchors: {
      ...(existing.anchors ?? {}),
      ...(next.anchors ?? {}),
      startEdgeIds: mergeArrayField(existing?.anchors?.startEdgeIds, next?.anchors?.startEdgeIds),
      endEdgeIds: mergeArrayField(existing?.anchors?.endEdgeIds, next?.anchors?.endEdgeIds),
      startNodeIds: mergeArrayField(existing?.anchors?.startNodeIds, next?.anchors?.startNodeIds),
      endNodeIds: mergeArrayField(existing?.anchors?.endNodeIds, next?.anchors?.endNodeIds),
    },
    duplicateMerge: {
      ...(existing.duplicateMerge ?? {}),
      ...(next.duplicateMerge ?? {}),
      mergedBatchCount: Math.max(
        Number(existing?.duplicateMerge?.mergedBatchCount) || 0,
        Number(next?.duplicateMerge?.mergedBatchCount) || 0
      ),
      mergedRouteSignatureCount: Math.max(
        Number(existing?.duplicateMerge?.mergedRouteSignatureCount) || 0,
        Number(next?.duplicateMerge?.mergedRouteSignatureCount) || 0
      ),
    },
    rejectionSuppression: {
      ...(existing.rejectionSuppression ?? {}),
      ...(next.rejectionSuppression ?? {}),
    },
    workerSuggestions: mergeObjectArrayField(existing.workerSuggestions, next.workerSuggestions),
    geometryCleanup: mergeGeometryCleanupMetadata(existing.geometryCleanup, next.geometryCleanup),
    buildingCrossings:
      next.buildingCrossings && typeof next.buildingCrossings === 'object' && !Array.isArray(next.buildingCrossings)
        ? cloneJson(next.buildingCrossings)
        : existing.buildingCrossings && typeof existing.buildingCrossings === 'object' && !Array.isArray(existing.buildingCrossings)
          ? cloneJson(existing.buildingCrossings)
          : null,
    reviewRecommendation:
      asTrimmedString(next.reviewRecommendation) || asTrimmedString(existing.reviewRecommendation) || 'review',
    discoveredAt: existing.discoveredAt ?? next.discoveredAt ?? new Date().toISOString(),
    lastRunId: asTrimmedString(next.runId) || asTrimmedString(next.lastRunId) || asTrimmedString(existing.lastRunId) || null,
  };
};

export const upsertAnalyticsCandidates = async ({
  candidates,
} = {}) => {
  const items = Array.isArray(candidates) ? candidates : [];
  const results = [];
  let createdCount = 0;
  let updatedCount = 0;

  for (const candidatePayload of items) {
    const explicitCandidateId = asTrimmedString(
      candidatePayload?.candidateId ?? candidatePayload?.id
    );
    const analyticsKey = resolveAnalyticsKey(candidatePayload);

    let record = null;
    if (explicitCandidateId) {
      record = await CandidateEdge.findById(explicitCandidateId);
    } else if (analyticsKey) {
      record = await CandidateEdge.findOne({ analyticsKey });
    }

    if (record && record.source !== 'analytics_discovery') {
      throw new Error(
        `Candidate route '${record._id?.toString?.() ?? record.id}' is not managed by analytics discovery.`
      );
    }

    const normalized = await normalizeCandidateCore(candidatePayload, {
      source: 'analytics_discovery',
      status:
        asTrimmedString(candidatePayload?.status) ||
        record?.status ||
        'pending',
      ...(record?.toObject?.() ?? {}),
    });

    if (!record) {
      record = new CandidateEdge({
        source: 'analytics_discovery',
        status: normalized.status,
      });
      createdCount += 1;
    } else {
      updatedCount += 1;
    }

    const existingTelemetrySourceIds = uniqueStrings(record.telemetrySourceIds ?? []);
    const nextTelemetrySourceIds = uniqueStrings(normalized.telemetrySourceIds ?? []);
    const newTelemetrySourceIds = nextTelemetrySourceIds.filter(
      (sourceId) => !existingTelemetrySourceIds.includes(sourceId)
    );
    const existingObservedCount = Math.max(0, Number(record.observedCount) || 0);
    const nextObservedCount = Math.max(0, Number(normalized.observedCount) || 0);
    const incrementalObservedCount =
      newTelemetrySourceIds.length > 0 ? newTelemetrySourceIds.length : record ? 0 : nextObservedCount;
    const mergedTelemetrySourceIds = uniqueStrings([...existingTelemetrySourceIds, ...nextTelemetrySourceIds]);
    const mergedObservedCount = Math.max(
      mergedTelemetrySourceIds.length,
      existingObservedCount + incrementalObservedCount
    );
    const existingSessionIds = uniqueStrings(record?.metadata?.sessionIds ?? []);
    const nextSessionIds = uniqueStrings(normalized?.metadata?.sessionIds ?? []);
    const mergedSessionIds = uniqueStrings([...existingSessionIds, ...nextSessionIds]);
    const previousWeight = Math.max(existingObservedCount, existingTelemetrySourceIds.length);
    const nextWeight = Math.max(incrementalObservedCount, newTelemetrySourceIds.length);
    const isLockedStatus = record.status === 'approved' || record.status === 'rejected';

    record.campusId = normalized.campusId;
    record.source = 'analytics_discovery';
    record.status = isLockedStatus ? record.status : normalized.status;
    record.analyticsKey = analyticsKey ?? record.analyticsKey ?? null;
    if (!isLockedStatus) {
      record.title = normalized.title;
      record.geometry = normalized.geometry;
      record.startAnchor = normalized.startAnchor;
      record.endAnchor = normalized.endAnchor;
      record.routeProperties = normalized.routeProperties;
    }
    record.observedCount = mergedObservedCount;
    record.distinctSessionCount = Math.max(
      Number(record.distinctSessionCount) || 0,
      Number(normalized.distinctSessionCount) || 0,
      mergedSessionIds.length
    );
    record.confidence = Math.max(
      Number(record.confidence) || 0,
      Number(normalized.confidence) || 0
    );
    record.averageDistanceM = weightedAverageMetric(
      record.averageDistanceM,
      previousWeight,
      normalized.averageDistanceM,
      nextWeight
    );
    record.averageDurationS = weightedAverageMetric(
      record.averageDurationS,
      previousWeight,
      normalized.averageDurationS,
      nextWeight
    );
    record.averageAccuracyM = weightedAverageMetric(
      record.averageAccuracyM,
      previousWeight,
      normalized.averageAccuracyM,
      nextWeight
    );
    record.improvementDistanceM = Math.max(
      Number(record.improvementDistanceM) || 0,
      Number(normalized.improvementDistanceM) || 0
    );
    record.telemetrySourceIds = mergedTelemetrySourceIds;
    record.metadata = mergeAnalyticsMetadata(record.metadata, normalized.metadata);

    if (record.source === 'analytics_discovery' && !record.review) {
      record.review = null;
    }

    await record.save();
    results.push(serializeCandidateEdge(record.toObject()));
  }

  return {
    items: results,
    createdCount,
    updatedCount,
  };
};

export const listRouteCandidates = async ({
  campusId,
  status = '',
  source = '',
  search = '',
  page = 1,
  pageSize = 25,
} = {}) => {
  const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number.parseInt(String(pageSize), 10) || 25));
  const filter = {};
  const explicitCampusId = asTrimmedString(campusId);

  if (explicitCampusId) {
    filter.campusId = explicitCampusId;
  }

  if (asTrimmedString(status)) {
    filter.status = asTrimmedString(status);
  }

  if (asTrimmedString(source)) {
    filter.source = asTrimmedString(source);
  }

  if (asTrimmedString(search)) {
    const searchRegex = candidateSearchRegex(asTrimmedString(search));
    filter.$or = [
      { title: searchRegex },
      { 'routeProperties.name': searchRegex },
      { 'publish.featureIds': searchRegex },
    ];
  }

  const [items, total, statuses, sources] = await Promise.all([
    CandidateEdge.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((safePage - 1) * safePageSize)
      .limit(safePageSize)
      .lean(),
    CandidateEdge.countDocuments(filter),
    CandidateEdge.distinct('status'),
    CandidateEdge.distinct('source'),
  ]);

  return {
    items: items.map((item) => serializeCandidateEdge(item)),
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    statuses: statuses.filter(Boolean).sort(),
    sources: sources.filter(Boolean).sort(),
  };
};

export const getRouteCandidate = async (candidateId) => {
  const normalizedId = asTrimmedString(candidateId);
  if (!normalizedId) {
    throw new Error('candidateId is required.');
  }

  const candidate = await CandidateEdge.findById(normalizedId).lean();
  if (!candidate) {
    throw new Error(`Candidate route '${normalizedId}' was not found.`);
  }

  return serializeCandidateEdge(candidate);
};

export const updateRouteCandidate = async (candidateId, payload, actor) => {
  const normalizedId = asTrimmedString(candidateId);
  if (!normalizedId) {
    throw new Error('candidateId is required.');
  }

  const existing = await CandidateEdge.findById(normalizedId);
  if (!existing) {
    throw new Error(`Candidate route '${normalizedId}' was not found.`);
  }

  const nextCandidate = await normalizeCandidateCore(payload, existing.toObject());
  existing.campusId = nextCandidate.campusId;
  existing.title = nextCandidate.title || existing.title;
  existing.geometry = nextCandidate.geometry;
  existing.startAnchor = nextCandidate.startAnchor;
  existing.endAnchor = nextCandidate.endAnchor;
  existing.routeProperties = nextCandidate.routeProperties;
  existing.observedCount = nextCandidate.observedCount;
  existing.distinctSessionCount = nextCandidate.distinctSessionCount;
  existing.confidence = nextCandidate.confidence;
  existing.averageDistanceM = nextCandidate.averageDistanceM;
  existing.averageDurationS = nextCandidate.averageDurationS;
  existing.averageAccuracyM = nextCandidate.averageAccuracyM;
  existing.improvementDistanceM = nextCandidate.improvementDistanceM;
  existing.telemetrySourceIds = nextCandidate.telemetrySourceIds;
  existing.metadata = nextCandidate.metadata;
  existing.review = {
    ...(existing.review?.toObject?.() ?? existing.review ?? {}),
    notes: asTrimmedString(payload?.reviewNotes) || existing.review?.notes || '',
  };
  await existing.save();

  await logAdminActivity({
    actionType: 'route_candidate_update',
    targetType: 'candidate_route',
    targetId: normalizedId,
    targetLabel: existing.title || normalizedId,
    details: `Updated candidate route '${normalizedId}'.`,
    actor: normalizeActor(actor),
    metadata: {
      candidateId: normalizedId,
      campusId: existing.campusId,
      status: existing.status,
    },
  });

  return serializeCandidateEdge(existing.toObject());
};

export const saveRecordingDraft = async (payload, actor) => {
  const draftId = asTrimmedString(payload?.draftId);
  const normalized = await normalizeCandidateCore(payload, {
    source: 'admin_recording',
    status: 'draft',
  });

  let record;
  if (draftId) {
    record = await CandidateEdge.findById(draftId);
  }

  if (!record) {
    record = new CandidateEdge({
      source: 'admin_recording',
      status: 'draft',
    });
  }

  Object.assign(record, normalized, {
    source: 'admin_recording',
    status: 'draft',
  });
  await record.save();

  await logAdminActivity({
    actionType: 'route_recording_draft_save',
    targetType: 'candidate_route',
    targetId: record._id?.toString?.(),
    targetLabel: record.title || 'Admin route draft',
    details: `Saved admin route draft '${record._id?.toString?.() ?? record.id}'.`,
    actor: normalizeActor(actor),
    metadata: {
      candidateId: record._id?.toString?.() ?? record.id,
      status: 'draft',
      campusId: record.campusId,
    },
  });

  return serializeCandidateEdge(record.toObject());
};

export const deleteRecordingDraft = async (draftId, actor) => {
  const normalizedId = asTrimmedString(draftId);
  if (!normalizedId) {
    throw new Error('draftId is required.');
  }

  const record = await CandidateEdge.findById(normalizedId);
  if (!record) {
    throw new Error(`Route draft '${normalizedId}' was not found.`);
  }

  if (record.source !== 'admin_recording' || record.status !== 'draft') {
    throw new Error(`Route draft '${normalizedId}' cannot be deleted from saved drafts.`);
  }

  const serialized = serializeCandidateEdge(record.toObject());
  await record.deleteOne();

  await logAdminActivity({
    actionType: 'route_recording_draft_delete',
    targetType: 'candidate_route',
    targetId: normalizedId,
    targetLabel: record.title || 'Admin route draft',
    details: `Deleted admin route draft '${normalizedId}'.`,
    actor: normalizeActor(actor),
    metadata: {
      candidateId: normalizedId,
      status: 'draft',
      campusId: record.campusId,
      source: record.source,
    },
  });

  return serialized;
};

export const submitRecordingCandidate = async (payload, actor) => {
  const draftId = asTrimmedString(payload?.draftId);
  let record = null;

  if (draftId) {
    record = await CandidateEdge.findById(draftId);
  }

  const normalized = await normalizeCandidateCore(payload, {
    source: 'admin_recording',
    status: 'pending',
    ...(record?.toObject?.() ?? {}),
  });

  if (!record) {
    record = new CandidateEdge({
      source: 'admin_recording',
      status: 'pending',
    });
  }

  Object.assign(record, normalized, {
    source: 'admin_recording',
    status: 'pending',
  });
  await record.save();

  await logAdminActivity({
    actionType: 'route_recording_submit',
    targetType: 'candidate_route',
    targetId: record._id?.toString?.(),
    targetLabel: record.title || 'Admin recorded route',
    details: `Submitted admin recorded route '${record._id?.toString?.() ?? record.id}' for review.`,
    actor: normalizeActor(actor),
    metadata: {
      candidateId: record._id?.toString?.() ?? record.id,
      status: 'pending',
      campusId: record.campusId,
      source: record.source,
    },
  });

  return serializeCandidateEdge(record.toObject());
};

export const rejectRouteCandidate = async (candidateId, payload, actor) => {
  const normalizedId = asTrimmedString(candidateId);
  const candidate = await CandidateEdge.findById(normalizedId);

  if (!candidate) {
    throw new Error(`Candidate route '${normalizedId}' was not found.`);
  }

  candidate.status = 'rejected';
  candidate.review = {
    ...(candidate.review?.toObject?.() ?? candidate.review ?? {}),
    reviewedAt: new Date(),
    reviewedBy: normalizeActor(actor),
    notes: asTrimmedString(payload?.notes),
    rejectionReason: asTrimmedString(payload?.rejectionReason ?? payload?.reason),
  };
  await candidate.save();

  await logAdminActivity({
    actionType: 'route_candidate_reject',
    targetType: 'candidate_route',
    targetId: normalizedId,
    targetLabel: candidate.title || normalizedId,
    details: `Rejected candidate route '${normalizedId}'.`,
    actor: normalizeActor(actor),
    metadata: {
      candidateId: normalizedId,
      campusId: candidate.campusId,
      reason: candidate.review.rejectionReason,
    },
  });

  return serializeCandidateEdge(candidate.toObject());
};

export const approveRouteCandidate = async (candidateId, payload, actor) => {
  const normalizedId = asTrimmedString(candidateId);
  const candidate = await CandidateEdge.findById(normalizedId);

  if (!candidate) {
    throw new Error(`Candidate route '${normalizedId}' was not found.`);
  }

  if (payload && (payload.geometry || payload.points || payload.title || typeof payload.accessible === 'boolean')) {
    const normalized = await normalizeCandidateCore(payload, candidate.toObject());
    Object.assign(candidate, normalized);
  }

  const { features, featureIds, edgeId, edgeGeometry } = buildApprovalFeatures(candidate);
  const datasetMutation = await bulkUpsertDatasetFeatures(
    'routing',
    {
      type: 'FeatureCollection',
      features,
    },
    normalizeActor(actor)
  );

  const overlay = await upsertRoutingWeightOverlay({
    campusId: candidate.campusId,
    edges: [buildInitialOverlayEntry(candidate, edgeId)],
    metadata: {
      windowDays: 7,
      congestionWindowMinutes: 15,
      source: 'candidate_approval',
      candidateId: normalizedId,
    },
  });

  candidate.status = 'approved';
  candidate.geometry = edgeGeometry;
  candidate.review = {
    ...(candidate.review?.toObject?.() ?? candidate.review ?? {}),
    reviewedAt: new Date(),
    reviewedBy: normalizeActor(actor),
    notes: asTrimmedString(payload?.notes),
    rejectionReason: '',
  };
  candidate.publish = {
    publishedAt: new Date(),
    publishedBy: normalizeActor(actor),
    routingRevisionId: datasetMutation.dataset.revisionId,
    featureIds,
    overlayVersion: overlay.version,
  };
  await candidate.save();

  await logAdminActivity({
    actionType: 'route_candidate_approve',
    targetType: 'candidate_route',
    targetId: normalizedId,
    targetLabel: candidate.title || normalizedId,
    details: `Approved candidate route '${normalizedId}' and published it into the routing dataset.`,
    actor: normalizeActor(actor),
    metadata: {
      candidateId: normalizedId,
      campusId: candidate.campusId,
      routingRevisionId: datasetMutation.dataset.revisionId,
      featureIds,
      overlayVersion: overlay.version,
    },
  });

  await logAdminActivity({
    actionType: 'admin_route_publish',
    targetType: 'dataset',
    targetId: 'routing',
    targetLabel: 'routing dataset',
    details: `Published admin route '${normalizedId}' into the live routing dataset.`,
    actor: normalizeActor(actor),
    metadata: {
      datasetType: 'routing',
      revisionId: datasetMutation.dataset.revisionId,
      candidateId: normalizedId,
      featureIds,
    },
  });

  return {
    candidate: serializeCandidateEdge(candidate.toObject()),
    datasetMutation,
    overlay,
  };
};
