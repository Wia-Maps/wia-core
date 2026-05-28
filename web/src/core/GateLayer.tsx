import { useEffect, useMemo, useRef } from 'react';
import type { FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { useAppStore } from '../store/useAppStore';
import type { RoutePreview } from '../store/useAppStore';
import type { MapEngineAdapter } from './mapEngineTypes';
import {
  collectGateFeatures,
  normalizeGateRole,
  resolveGateFenceId,
  resolveGateName,
  resolveGateNodeId,
  type RoutingFeatureCollection,
} from './routingGateUtils';

interface GateLayerProps {
  map: MapEngineAdapter | null;
  routingData?: RoutingFeatureCollection | null;
  routePreview?: RoutePreview | null;
}

const GATE_SOURCE_ID = 'wia-routing-gates';
const GATE_ROUTE_HALO_LAYER_ID = 'wia-routing-gates-route-halo';
const GATE_SELECTED_HALO_LAYER_ID = 'wia-routing-gates-selected-halo';
const GATE_MARKER_LAYER_ID = 'wia-routing-gates-marker';

const GATE_LAYER_IDS = [
  GATE_ROUTE_HALO_LAYER_ID,
  GATE_SELECTED_HALO_LAYER_ID,
  GATE_MARKER_LAYER_ID,
] as const;

const buildGateCollection = (
  routingData: RoutingFeatureCollection | null | undefined,
  selectedLocationId: string | null | undefined,
  routePreview: RoutePreview | null | undefined
): FeatureCollection<Point, Record<string, unknown>> => {
  const routeNodeIds = new Set(routePreview?.graph_node_ids ?? []);
  const features = collectGateFeatures(routingData).map((feature, index) => {
    const gateId = resolveGateNodeId(feature, index);
    const role = normalizeGateRole(feature.properties?.gate_role ?? feature.properties?.gateRole);
    const fenceId = resolveGateFenceId(feature);

    return {
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        __gateId: gateId,
        __role: role,
        __fenceId: fenceId,
        __isSelected: selectedLocationId === gateId,
        __isRouteUsed: routeNodeIds.has(gateId),
      },
    };
  });

  return {
    type: 'FeatureCollection',
    features,
  };
};

const syncGateSource = (
  map: MapEngineAdapter['nativeMap'],
  data: FeatureCollection<Point, Record<string, unknown>>
): void => {
  const source = map.getSource(GATE_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(data);
};

const removeGateLayers = (map: MapEngineAdapter['nativeMap']): void => {
  GATE_LAYER_IDS.forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  });

  if (map.getSource(GATE_SOURCE_ID)) {
    map.removeSource(GATE_SOURCE_ID);
  }
};

export const GateLayer: React.FC<GateLayerProps> = ({ map, routingData, routePreview }) => {
  const selectedLocation = useAppStore((state) => state.selectedLocation);
  const selectLocation = useAppStore((state) => state.selectLocation);
  const openBottomSheet = useAppStore((state) => state.openBottomSheet);
  const gateCollection = useMemo(
    () => buildGateCollection(routingData, selectedLocation?.id, routePreview),
    [routePreview, routingData, selectedLocation?.id]
  );
  const gateCollectionRef = useRef(gateCollection);
  const selectLocationRef = useRef(selectLocation);
  const openBottomSheetRef = useRef(openBottomSheet);

  gateCollectionRef.current = gateCollection;
  selectLocationRef.current = selectLocation;
  openBottomSheetRef.current = openBottomSheet;

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap || !nativeMap.isStyleLoaded()) {
      return;
    }

    syncGateSource(nativeMap, gateCollection);
  }, [gateCollection, map]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    const ensureLayers = (): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      if (!nativeMap.getSource(GATE_SOURCE_ID)) {
        nativeMap.addSource(GATE_SOURCE_ID, {
          type: 'geojson',
          data: gateCollectionRef.current,
        });
      } else {
        syncGateSource(nativeMap, gateCollectionRef.current);
      }

      if (!nativeMap.getLayer(GATE_ROUTE_HALO_LAYER_ID)) {
        nativeMap.addLayer({
          id: GATE_ROUTE_HALO_LAYER_ID,
          type: 'circle',
          source: GATE_SOURCE_ID,
          filter: ['==', ['get', '__isRouteUsed'], true],
          paint: {
            'circle-color': '#fef3c7',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 9, 17, 12, 20, 16],
            'circle-opacity': 0.72,
            'circle-stroke-color': '#f59e0b',
            'circle-stroke-width': 1.6,
          },
        });
      }

      if (!nativeMap.getLayer(GATE_SELECTED_HALO_LAYER_ID)) {
        nativeMap.addLayer({
          id: GATE_SELECTED_HALO_LAYER_ID,
          type: 'circle',
          source: GATE_SOURCE_ID,
          filter: ['==', ['get', '__isSelected'], true],
          paint: {
            'circle-color': '#d1fae5',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 13, 20, 17],
            'circle-opacity': 0.82,
            'circle-stroke-color': '#064e3b',
            'circle-stroke-width': 2,
          },
        });
      }

      if (!nativeMap.getLayer(GATE_MARKER_LAYER_ID)) {
        nativeMap.addLayer({
          id: GATE_MARKER_LAYER_ID,
          type: 'circle',
          source: GATE_SOURCE_ID,
          paint: {
            'circle-color': [
              'match',
              ['get', '__role'],
              'entry',
              '#16a34a',
              'exit',
              '#111827',
              'both',
              '#047857',
              '#047857',
            ],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5.5, 17, 7, 20, 9],
            'circle-opacity': 0.98,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2.4,
          },
        });
      }
    };

    const handleGateClick = (event: MapMouseEvent): void => {
      if (!nativeMap.isStyleLoaded() || !nativeMap.getLayer(GATE_MARKER_LAYER_ID)) {
        return;
      }

      const feature = nativeMap.queryRenderedFeatures(event.point, {
        layers: [GATE_MARKER_LAYER_ID],
      })[0];
      if (!feature || feature.geometry.type !== 'Point') {
        return;
      }

      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      const coordinates = feature.geometry.coordinates;
      const gateId = typeof properties.__gateId === 'string' ? properties.__gateId : 'unknown_gate';
      const role = typeof properties.__role === 'string' ? properties.__role : 'both';
      const fenceId = typeof properties.__fenceId === 'string' ? properties.__fenceId : null;

      selectLocationRef.current({
        id: gateId,
        name: resolveGateName(
          {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates,
            },
            properties,
          },
          `Gate ${gateId}`
        ),
        type: `Gate (${role})`,
        coordinates: [Number(coordinates[1]), Number(coordinates[0])],
        properties: {
          ...properties,
          fence_id: fenceId,
          gate_role: role,
        },
      });
      openBottomSheetRef.current();
    };

    const handleGateMouseMove = (event: MapMouseEvent): void => {
      if (!nativeMap.isStyleLoaded() || !nativeMap.getLayer(GATE_MARKER_LAYER_ID)) {
        nativeMap.getCanvas().style.cursor = '';
        return;
      }

      const feature = nativeMap.queryRenderedFeatures(event.point, {
        layers: [GATE_MARKER_LAYER_ID],
      })[0];
      nativeMap.getCanvas().style.cursor = feature ? 'pointer' : '';
    };

    const handleCanvasMouseLeave = (): void => {
      nativeMap.getCanvas().style.cursor = '';
    };

    const ensureLayersOnIdle = (): void => {
      ensureLayers();
    };

    const cleanupLoad = map.on('load', ensureLayers);
    const cleanupStyle = map.on('styledata', ensureLayers);
    nativeMap.on('idle', ensureLayersOnIdle);
    nativeMap.on('click', handleGateClick);
    nativeMap.on('mousemove', handleGateMouseMove);
    nativeMap.getCanvas().addEventListener('mouseleave', handleCanvasMouseLeave);
    ensureLayers();

    return (): void => {
      cleanupLoad();
      cleanupStyle();
      nativeMap.off('idle', ensureLayersOnIdle);
      nativeMap.off('click', handleGateClick);
      nativeMap.off('mousemove', handleGateMouseMove);
      nativeMap.getCanvas().removeEventListener('mouseleave', handleCanvasMouseLeave);
      nativeMap.getCanvas().style.cursor = '';
      if (nativeMap.isStyleLoaded()) {
        removeGateLayers(nativeMap);
      }
    };
  }, [map]);

  return null;
};

export default GateLayer;
