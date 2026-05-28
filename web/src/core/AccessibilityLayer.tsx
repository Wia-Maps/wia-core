import { useEffect, useMemo } from 'react';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import type { GeoJSONSource } from 'maplibre-gl';
import type { MapEngineAdapter } from './mapEngineTypes';

interface FeatureProperties {
  id?: string;
  name?: string;
  type?: string;
  features?: string[];
  floor_count?: number;
  [key: string]: unknown;
}

type CampusFeature = Feature<Geometry, FeatureProperties>;
type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;

interface AccessibilityLayerProps {
  map: MapEngineAdapter | null;
  geojsonData?: CampusCollection | null;
  enabled: boolean;
}

interface AccessibilityNode {
  id: string;
  name: string;
  coordinates: [number, number];
  hasRamp: boolean;
  hasElevator: boolean;
}

const ACCESSIBILITY_SOURCE_ID = 'wia-accessibility';
const ACCESSIBILITY_LINK_LAYER_ID = 'wia-accessibility-links';
const ACCESSIBILITY_POINT_LAYER_ID = 'wia-accessibility-points';

const MAX_LINK_DISTANCE_M = 220;

const toLatLng = (position: Position): [number, number] => [position[1], position[0]];

const getCentroidFromRing = (ring: Position[]): [number, number] | null => {
  if (ring.length === 0) {
    return null;
  }

  const { lat, lng } = ring.reduce(
    (accumulator, point) => ({
      lat: accumulator.lat + point[1],
      lng: accumulator.lng + point[0],
    }),
    { lat: 0, lng: 0 }
  );

  return [lat / ring.length, lng / ring.length];
};

const featureCoordinates = (feature: CampusFeature): [number, number] | null => {
  if (feature.geometry.type === 'Point') {
    return toLatLng(feature.geometry.coordinates as Position);
  }

  if (feature.geometry.type === 'Polygon') {
    const firstRing = feature.geometry.coordinates[0] as Position[] | undefined;
    return firstRing ? getCentroidFromRing(firstRing) : null;
  }

  if (feature.geometry.type === 'MultiPolygon') {
    const firstRing = feature.geometry.coordinates[0]?.[0] as Position[] | undefined;
    return firstRing ? getCentroidFromRing(firstRing) : null;
  }

  return null;
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const haversineMeters = (from: [number, number], to: [number, number]): number => {
  const earthRadius = 6371000;
  const dLat = toRadians(to[0] - from[0]);
  const dLng = toRadians(to[1] - from[1]);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(from[0])) *
      Math.cos(toRadians(to[0])) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const buildAccessibilityNodes = (features: CampusFeature[]): AccessibilityNode[] => {
  const nodes: AccessibilityNode[] = [];

  features.forEach((feature, index) => {
    const coordinates = featureCoordinates(feature);
    if (!coordinates) {
      return;
    }

    const properties = feature.properties ?? {};
    const type = String(properties.type ?? '').toLowerCase();
    const featureTags = Array.isArray(properties.features)
      ? properties.features
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.toLowerCase())
      : [];

    const floorCount = typeof properties.floor_count === 'number' ? properties.floor_count : 1;

    const hasRampHint = featureTags.some(
      (tag) => tag.includes('ramp') || tag.includes('accessible') || tag.includes('wheelchair')
    );
    const hasElevatorHint = featureTags.some((tag) => tag.includes('elevator') || tag.includes('lift'));
    const likelyPublicBuilding = ['academic', 'library', 'facility', 'administrative', 'hostel', 'cafeteria'].includes(type);

    const hasRamp = hasRampHint || likelyPublicBuilding || type === 'gate';
    const hasElevator = hasElevatorHint || floorCount >= 3;

    if (!hasRamp && !hasElevator) {
      return;
    }

    nodes.push({
      id: String(feature.id ?? properties.id ?? `access_${index}`),
      name: String(properties.name ?? 'Accessible point'),
      coordinates,
      hasRamp,
      hasElevator,
    });
  });

  return nodes.slice(0, 26);
};

const buildRouteSegments = (
  nodes: AccessibilityNode[]
): Array<[[number, number], [number, number]]> => {
  const links: Array<[[number, number], [number, number]]> = [];
  const seen = new Set<string>();

  nodes.forEach((node, index) => {
    const nearest = nodes
      .map((candidate, candidateIndex) => ({
        candidate,
        candidateIndex,
        distance:
          index === candidateIndex
            ? Number.POSITIVE_INFINITY
            : haversineMeters(node.coordinates, candidate.coordinates),
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 2);

    nearest.forEach((entry) => {
      if (entry.distance > MAX_LINK_DISTANCE_M) {
        return;
      }

      const key =
        index < entry.candidateIndex
          ? `${index}_${entry.candidateIndex}`
          : `${entry.candidateIndex}_${index}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      links.push([node.coordinates, entry.candidate.coordinates]);
    });
  });

  return links;
};

const emptyCollection = (): FeatureCollection => ({
  type: 'FeatureCollection',
  features: [],
});

export const AccessibilityLayer: React.FC<AccessibilityLayerProps> = ({
  map,
  geojsonData,
  enabled,
}) => {
  const nodes = useMemo(() => {
    if (!geojsonData?.features) {
      return [];
    }

    return buildAccessibilityNodes(geojsonData.features as CampusFeature[]);
  }, [geojsonData]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    const syncAccessibilityLayers = (): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      const sourceData =
        enabled && nodes.length > 0
          ? {
              type: 'FeatureCollection' as const,
              features: [
                ...buildRouteSegments(nodes).map(([from, to]) => ({
                  type: 'Feature' as const,
                  properties: { role: 'link' },
                  geometry: {
                    type: 'LineString' as const,
                    coordinates: [
                      [from[1], from[0]],
                      [to[1], to[0]],
                    ],
                  },
                })),
                ...nodes.map((node) => ({
                  type: 'Feature' as const,
                  properties: {
                    role: 'node',
                    hasElevator: node.hasElevator,
                  },
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [node.coordinates[1], node.coordinates[0]],
                  },
                })),
              ],
            }
          : emptyCollection();

      const source = nativeMap.getSource(ACCESSIBILITY_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) {
        nativeMap.addSource(ACCESSIBILITY_SOURCE_ID, {
          type: 'geojson',
          data: sourceData,
        });

        nativeMap.addLayer({
          id: ACCESSIBILITY_LINK_LAYER_ID,
          type: 'line',
          source: ACCESSIBILITY_SOURCE_ID,
          filter: ['==', ['get', 'role'], 'link'],
          paint: {
            'line-color': '#10b981',
            'line-width': 2,
            'line-opacity': 0.75,
            'line-dasharray': [2, 2],
          },
        });

        nativeMap.addLayer({
          id: ACCESSIBILITY_POINT_LAYER_ID,
          type: 'circle',
          source: ACCESSIBILITY_SOURCE_ID,
          filter: ['==', ['get', 'role'], 'node'],
          paint: {
            'circle-radius': ['case', ['boolean', ['get', 'hasElevator'], false], 5.5, 4.8],
            'circle-color': ['case', ['boolean', ['get', 'hasElevator'], false], '#0ea5e9', '#34d399'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
            'circle-opacity': 0.95,
          },
        });
        return;
      }

      source.setData(sourceData);
    };

    const cleanupLoad = map.on('load', syncAccessibilityLayers);
    const cleanupStyle = map.on('styledata', syncAccessibilityLayers);
    syncAccessibilityLayers();

    return (): void => {
      cleanupLoad();
      cleanupStyle();
      if (!nativeMap.isStyleLoaded()) {
        return;
      }
      if (nativeMap.getLayer(ACCESSIBILITY_POINT_LAYER_ID)) {
        nativeMap.removeLayer(ACCESSIBILITY_POINT_LAYER_ID);
      }
      if (nativeMap.getLayer(ACCESSIBILITY_LINK_LAYER_ID)) {
        nativeMap.removeLayer(ACCESSIBILITY_LINK_LAYER_ID);
      }
      if (nativeMap.getSource(ACCESSIBILITY_SOURCE_ID)) {
        nativeMap.removeSource(ACCESSIBILITY_SOURCE_ID);
      }
    };
  }, [enabled, map, nodes]);

  return null;
};

export default AccessibilityLayer;