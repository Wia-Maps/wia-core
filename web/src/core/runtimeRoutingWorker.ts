/// <reference lib="webworker" />

import { buildCampusRoutePreview, buildRoutingProjectionIndex } from './navigation';
import { withInferredLocationEntrances } from './routingEntranceInference';
import {
  applyRoutingWeightOverrides,
  importRoutingGraph,
  isEmptyRoutingGraph,
  type CampusRoutingGraph,
} from './routingGraph';
import type {
  BuildExactRouteRequest,
  PrepareRuntimeRoutingRequest,
  PrepareRuntimeRoutingResult,
  RuntimeErrorResponse,
  RuntimeReadyResponse,
  RuntimeRoutingWorkerRequest,
  RouteReadyResponse,
} from './runtimeRoutingTypes';

type RoutingRuntimeKind = 'graph' | 'empty' | 'invalid';

interface PreparedRoutingRuntime {
  kind: RoutingRuntimeKind;
  graph: CampusRoutingGraph | null;
  locations: PrepareRuntimeRoutingRequest['locations'];
  projectionIndex: ReturnType<typeof buildRoutingProjectionIndex>;
}

const workerScope = self as DedicatedWorkerGlobalScope;

let activeRuntime: PreparedRoutingRuntime = {
  kind: 'invalid',
  graph: null,
  locations: null,
  projectionIndex: null,
};

const cancelledRouteRequestIds = new Set<number>();

const postRuntimeReady = (requestId: number, result: PrepareRuntimeRoutingResult): void => {
  workerScope.postMessage({
    type: 'runtimeReady',
    requestId,
    result,
  } satisfies RuntimeReadyResponse);
};

const postRouteReady = (requestId: number, preview: RouteReadyResponse['preview']): void => {
  workerScope.postMessage({
    type: 'routeReady',
    requestId,
    preview,
  } satisfies RouteReadyResponse);
};

const postRuntimeError = (requestId: number, message: string): void => {
  workerScope.postMessage({
    type: 'runtimeError',
    requestId,
    message,
  } satisfies RuntimeErrorResponse);
};

const prepareRuntime = (message: PrepareRuntimeRoutingRequest): void => {
  const result = importRoutingGraph(message.routingDataset, {
    strict: false,
    allowEmptyGraph: true,
    locations: message.locations,
  });

  const intentionalEmptyGraph =
    result.errors.length === 0 &&
    result.warnings.length === 0 &&
    isEmptyRoutingGraph(result.graph);

  if (intentionalEmptyGraph) {
    activeRuntime = {
      kind: 'empty',
      graph: null,
      locations: message.locations,
      projectionIndex: null,
    };
    postRuntimeReady(message.requestId, {
      kind: 'empty',
      datasetVersion: message.datasetVersion,
      sourceLabel: message.sourceLabel,
      warnings: result.warnings,
      errors: result.errors,
      nodeCount: 0,
      edgeCount: 0,
    });
    return;
  }

  if (!result.graph || result.graph.edges.length === 0) {
    postRuntimeReady(message.requestId, {
      kind: 'invalid',
      datasetVersion: message.datasetVersion,
      sourceLabel: message.sourceLabel,
      warnings: result.warnings,
      errors: result.errors,
      nodeCount: 0,
      edgeCount: 0,
    });
    return;
  }

  const weightedGraph = applyRoutingWeightOverrides(
    result.graph,
    message.overlay.map((entry) => ({
      edgeId: entry.edgeId,
      effectiveWeightM: entry.effectiveWeightM,
    }))
  );

  if (!weightedGraph || weightedGraph.edges.length === 0) {
    postRuntimeReady(message.requestId, {
      kind: 'invalid',
      datasetVersion: message.datasetVersion,
      sourceLabel: message.sourceLabel,
      warnings: result.warnings,
      errors: [...result.errors, 'Weighted routing graph is empty after overrides.'],
      nodeCount: 0,
      edgeCount: 0,
    });
    return;
  }

  const graphWithInferredEntrances = withInferredLocationEntrances(weightedGraph, message.locations);
  const projectionIndex = buildRoutingProjectionIndex(graphWithInferredEntrances);

  activeRuntime = {
    kind: 'graph',
    graph: graphWithInferredEntrances,
    locations: message.locations,
    projectionIndex,
  };

  postRuntimeReady(message.requestId, {
    kind: 'graph',
    datasetVersion: message.datasetVersion,
    sourceLabel: message.sourceLabel,
    warnings: result.warnings,
    errors: result.errors,
    nodeCount: graphWithInferredEntrances?.nodes.size ?? 0,
    edgeCount: graphWithInferredEntrances?.edges.length ?? 0,
  });
};

const buildRoute = (message: BuildExactRouteRequest): void => {
  cancelledRouteRequestIds.delete(message.requestId);

  const preview = buildCampusRoutePreview({
    origin: message.origin,
    originLocationId: message.originLocationId,
    destination: message.destination,
    destinationId: message.destinationId,
    graph: activeRuntime.kind === 'graph' ? activeRuntime.graph : null,
    accessibilityMode: message.accessibilityMode,
    locations: activeRuntime.locations,
    projectionIndex: activeRuntime.projectionIndex,
  });

  if (cancelledRouteRequestIds.has(message.requestId)) {
    cancelledRouteRequestIds.delete(message.requestId);
    return;
  }

  postRouteReady(message.requestId, preview);
};

workerScope.onmessage = (event: MessageEvent<RuntimeRoutingWorkerRequest>) => {
  const message = event.data;

  try {
    if (message.type === 'prepareRuntimeRouting') {
      prepareRuntime(message);
      return;
    }

    if (message.type === 'buildExactRoute') {
      buildRoute(message);
      return;
    }

    if (message.type === 'cancelRoute') {
      cancelledRouteRequestIds.add(message.requestId);
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Routing worker failed.';
    postRuntimeError(message.requestId, messageText);
  }
};

export {};
