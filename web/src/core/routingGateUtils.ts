import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';

export type GateRole = 'entry' | 'exit' | 'both';

export type GateFeature = Feature<Point, Record<string, unknown>>;
export type RoutingFeatureCollection = FeatureCollection<Geometry, Record<string, unknown>>;

const textValue = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

export const normalizeGateRole = (value: unknown): GateRole => {
  const normalized = textValue(value).toLowerCase();
  if (normalized === 'entry' || normalized === 'exit' || normalized === 'both') {
    return normalized;
  }

  return 'both';
};

export const isGateFeature = (
  feature: Feature<Geometry, Record<string, unknown>> | null | undefined
): feature is GateFeature => {
  if (feature?.geometry?.type !== 'Point') {
    return false;
  }

  const properties = feature.properties ?? {};
  const kind = textValue(properties.kind).toLowerCase();
  return kind === 'gate' || textValue(properties.gate_role).length > 0 || textValue(properties.gateRole).length > 0;
};

export const resolveGateNodeId = (feature: GateFeature, fallback?: number | string): string => {
  const properties = feature.properties ?? {};
  const candidates = [
    properties.node_id,
    properties.nodeId,
    properties.id,
    feature.id,
    fallback,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return 'unknown_gate';
};

export const resolveGateFenceId = (feature: GateFeature): string | null => {
  const properties = feature.properties ?? {};
  const fenceId = textValue(properties.fence_id) || textValue(properties.fenceId) || textValue(properties.location_id);
  return fenceId || null;
};

export const resolveGateName = (feature: GateFeature, fallback: string): string => {
  const properties = feature.properties ?? {};
  return textValue(properties.name) || textValue(properties.label) || fallback;
};

export const collectGateFeatures = (
  routingData: RoutingFeatureCollection | null | undefined
): GateFeature[] => {
  if (!routingData?.features?.length) {
    return [];
  }

  return routingData.features.filter(isGateFeature);
};
