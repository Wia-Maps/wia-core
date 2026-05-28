import type { FeatureCollection, Geometry } from 'geojson';
import type { RouteAccessibilityMode, RoutePreview } from '../store/useAppStore';

export interface RoutingRuntimeOverlayEntry {
  edgeId: string;
  effectiveWeightM: number;
}

export type RoutingRuntimeDataset = FeatureCollection<Geometry, Record<string, unknown>>;

export interface PrepareRuntimeRoutingRequest {
  type: 'prepareRuntimeRouting';
  requestId: number;
  sourceLabel: string;
  datasetVersion: string;
  routingDataset: RoutingRuntimeDataset;
  locations: RoutingRuntimeDataset | null;
  overlay: RoutingRuntimeOverlayEntry[];
}

export interface BuildExactRouteRequest {
  type: 'buildExactRoute';
  requestId: number;
  origin: [number, number];
  originLocationId?: string | null;
  destination: [number, number];
  destinationId: string;
  accessibilityMode: RouteAccessibilityMode;
}

export interface CancelRouteRequest {
  type: 'cancelRoute';
  requestId: number;
}

export type RuntimeRoutingWorkerRequest =
  | PrepareRuntimeRoutingRequest
  | BuildExactRouteRequest
  | CancelRouteRequest;

export interface PrepareRuntimeRoutingResult {
  kind: 'graph' | 'empty' | 'invalid';
  datasetVersion: string;
  sourceLabel: string;
  warnings: string[];
  errors: string[];
  nodeCount: number;
  edgeCount: number;
}

export interface RuntimeReadyResponse {
  type: 'runtimeReady';
  requestId: number;
  result: PrepareRuntimeRoutingResult;
}

export interface RouteReadyResponse {
  type: 'routeReady';
  requestId: number;
  preview: RoutePreview;
}

export interface RuntimeErrorResponse {
  type: 'runtimeError';
  requestId: number;
  message: string;
}

export type RuntimeRoutingWorkerResponse =
  | RuntimeReadyResponse
  | RouteReadyResponse
  | RuntimeErrorResponse;
