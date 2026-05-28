import { useEffect, useRef } from 'react';
import type { FeatureCollection, LineString, Point } from 'geojson';
import { type FilterSpecification, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { useAppStore, type RouteFocusHighlight, type RoutePreview } from '../store/useAppStore';
import type { MapEngineAdapter } from './mapEngineTypes';
import {
  collectGateFeatures,
  resolveGateNodeId,
  type RoutingFeatureCollection,
} from './routingGateUtils';

interface RoutePreviewLayerProps {
  map: MapEngineAdapter | null;
  routePreview: RoutePreview | null;
  routingData?: RoutingFeatureCollection | null;
  focusHighlight?: RouteFocusHighlight | null;
}

const CUSTOM_ROADS_SOURCE_ID = 'custom-roads';
const CUSTOM_ROADS_LAYER_ID = 'wia-custom-roads';
const ROUTE_SOURCE_ID = 'route';
const ROUTE_HINT_LAYER_ID = 'wia-route-preview-hint';
const ROUTE_GLOW_LAYER_ID = 'wia-route-preview-glow';
const ROUTE_LINE_LAYER_ID = 'wia-route-preview-line';
const ROUTE_GATE_LAYER_ID = 'wia-route-preview-gate';
const ROUTE_ORIGIN_LAYER_ID = 'wia-route-preview-origin';
const ROUTE_FOCUS_LINE_LAYER_ID = 'wia-route-preview-focus-line';
const ROUTE_FOCUS_POINT_LAYER_ID = 'wia-route-preview-focus-point';
const ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID = 'wia-route-preview-focus-arrow-outline';
const ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID = 'wia-route-preview-focus-arrow-contrast';
const ROUTE_FOCUS_ARROW_INNER_LAYER_ID = 'wia-route-preview-focus-arrow-inner';
const LOCATION_STRUCTURE_EXTRUSION_LAYER_ID = 'wia-locations-structure-extrusion';
const LOCATION_FENCE_WALL_LAYER_ID = 'wia-locations-fence-wall';
const ROUTE_LAYER_RETRY_DELAYS_MS = [40, 120, 280, 650, 1200];
const nearlySamePoint = (left: [number, number], right: [number, number]): boolean => {
  return Math.abs(left[0] - right[0]) < 0.0000005 && Math.abs(left[1] - right[1]) < 0.0000005;
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

const bearingBetweenPoints = (from: [number, number], to: [number, number]): number => {
  const phi1 = toRadians(from[0]);
  const phi2 = toRadians(to[0]);
  const deltaLambda = toRadians(to[1] - from[1]);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const pointDistanceMeters = (left: [number, number], right: [number, number]): number => {
  const referenceLat = (left[0] + right[0]) / 2;
  const latFactor = 110540;
  const lngFactor = 111320 * Math.cos(toRadians(referenceLat));
  return Math.hypot((right[1] - left[1]) * lngFactor, (right[0] - left[0]) * latFactor);
};

const routePathBearing = (path: [number, number][], fallback: number | null): number | null => {
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (pointDistanceMeters(path[index - 1], path[index]) > 0.8) {
      return bearingBetweenPoints(path[index - 1], path[index]);
    }
  }

  return fallback;
};

const destinationPoint = (
  start: [number, number],
  bearingDeg: number,
  distanceM: number
): [number, number] => {
  const earthRadiusM = 6371000;
  const angularDistance = distanceM / earthRadiusM;
  const bearing = toRadians(bearingDeg);
  const startLat = toRadians(start[0]);
  const startLng = toRadians(start[1]);
  const nextLat = Math.asin(
    Math.sin(startLat) * Math.cos(angularDistance) +
      Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const nextLng =
    startLng +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLat),
      Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(nextLat)
    );

  return [toDegrees(nextLat), toDegrees(nextLng)];
};

const offsetPoint = (
  point: [number, number],
  forwardBearingDeg: number,
  rightM: number,
  forwardM: number
): [number, number] => {
  const distanceM = Math.hypot(rightM, forwardM);
  if (distanceM <= 0) {
    return point;
  }

  const bearing = forwardBearingDeg + toDegrees(Math.atan2(rightM, forwardM));
  return destinationPoint(point, bearing, distanceM);
};

interface GroundArrowGeometry {
  body: [number, number][];
  head: [number, number][];
}

const createFallbackGroundArrowGeometry = (highlight: RouteFocusHighlight): GroundArrowGeometry | null => {
  const pivot = highlight.point;
  const bearing = highlight.bearingDeg;
  if (!pivot || bearing === null) {
    return null;
  }

  const rightTurn = highlight.maneuver === 'right' || highlight.maneuver === 'sharp-right';
  const leftTurn = highlight.maneuver === 'left' || highlight.maneuver === 'sharp-left';

  if (rightTurn || leftTurn) {
    const side = rightTurn ? 1 : -1;
    const end = offsetPoint(pivot, bearing, side * 17, 11);
    return {
      body: [
        offsetPoint(pivot, bearing, 0, -22),
        offsetPoint(pivot, bearing, 0, -8),
        offsetPoint(pivot, bearing, side * 8, 4),
        end,
      ],
      head: [
        offsetPoint(end, bearing, side * -8, 9),
        end,
        offsetPoint(end, bearing, side * -9, -7),
      ],
    };
  }

  if (highlight.maneuver === 'uturn') {
    const end = offsetPoint(pivot, bearing, -18, -5);
    return {
      body: [
        offsetPoint(pivot, bearing, 10, -22),
        offsetPoint(pivot, bearing, 10, 2),
        offsetPoint(pivot, bearing, 4, 15),
        offsetPoint(pivot, bearing, -10, 14),
        offsetPoint(pivot, bearing, -18, 4),
        end,
      ],
      head: [
        offsetPoint(end, bearing, -8, 7),
        end,
        offsetPoint(end, bearing, -4, -10),
      ],
    };
  }

  const end = offsetPoint(pivot, bearing, 0, 18);
  return {
    body: [offsetPoint(pivot, bearing, 0, -20), end],
    head: [
      offsetPoint(end, bearing, -8, -9),
      end,
      offsetPoint(end, bearing, 8, -9),
    ],
  };
};

const createGroundArrowGeometry = (highlight: RouteFocusHighlight): GroundArrowGeometry | null => {
  const rawPath = (highlight.arrowPath && highlight.arrowPath.length >= 2 ? highlight.arrowPath : highlight.path)
    .filter((point, index, list) => index === 0 || pointDistanceMeters(list[index - 1], point) > 0.5);

  if (rawPath.length < 2) {
    return createFallbackGroundArrowGeometry(highlight);
  }

  const end = rawPath[rawPath.length - 1];
  const beforeEnd = [...rawPath].reverse().find((point) => pointDistanceMeters(end, point) > 1.4);
  const outgoingBearing = beforeEnd ? bearingBetweenPoints(beforeEnd, end) : routePathBearing(rawPath, highlight.bearingDeg);

  if (outgoingBearing === null) {
    return createFallbackGroundArrowGeometry(highlight);
  }

  return {
    body: rawPath,
    head: [
      destinationPoint(end, outgoingBearing + 214, 8.5),
      end,
      destinationPoint(end, outgoingBearing + 146, 8.5),
    ],
  };
};

const emptyRouteCollection = (): FeatureCollection<LineString | Point> => ({
  type: 'FeatureCollection',
  features: [],
});

const emptyRoadCollection = (): FeatureCollection<LineString> => ({
  type: 'FeatureCollection',
  features: [],
});

const getLabelLayerId = (map: MapLibreMap): string | undefined => {
  const layers = map.getStyle()?.layers ?? [];
  return layers.find((layer) => layer.type === 'symbol' && Boolean(layer.layout?.['text-field']))?.id;
};

const getRouteInsertionLayerId = (map: MapLibreMap): string | undefined => {
  if (map.getLayer(LOCATION_STRUCTURE_EXTRUSION_LAYER_ID)) {
    return LOCATION_STRUCTURE_EXTRUSION_LAYER_ID;
  }

  if (map.getLayer(LOCATION_FENCE_WALL_LAYER_ID)) {
    return LOCATION_FENCE_WALL_LAYER_ID;
  }

  return getLabelLayerId(map);
};

const moveLayerBefore = (map: MapLibreMap, layerId: string, beforeId?: string): void => {
  if (!map.getLayer(layerId)) {
    return;
  }

  if (beforeId && map.getLayer(beforeId)) {
    map.moveLayer(layerId, beforeId);
    return;
  }

  map.moveLayer(layerId);
};

const moveLayerToTop = (map: MapLibreMap, layerId: string): void => {
  if (map.getLayer(layerId)) {
    map.moveLayer(layerId);
  }
};

const addSources = (
  map: MapLibreMap,
  routeData: FeatureCollection<LineString | Point>
): void => {
  const routeSource = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
  if (!routeSource) {
    map.addSource(ROUTE_SOURCE_ID, {
      type: 'geojson',
      data: routeData,
    });
  } else {
    routeSource.setData(routeData);
  }

  const roadsSource = map.getSource(CUSTOM_ROADS_SOURCE_ID) as GeoJSONSource | undefined;
  if (!roadsSource) {
    map.addSource(CUSTOM_ROADS_SOURCE_ID, {
      type: 'geojson',
      data: emptyRoadCollection(),
    });
  }
};

const addRoadLayer = (map: MapLibreMap, beforeId?: string): void => {
  if (!map.getLayer(CUSTOM_ROADS_LAYER_ID)) {
    map.addLayer(
      {
        id: CUSTOM_ROADS_LAYER_ID,
        type: 'line',
        source: CUSTOM_ROADS_SOURCE_ID,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#d7e3ea',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 3.5, 20, 5],
          'line-opacity': 0.9,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, CUSTOM_ROADS_LAYER_ID, beforeId);
  }
};

const addRouteLayer = (map: MapLibreMap, beforeId?: string): void => {
  if (!map.getLayer(ROUTE_HINT_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_HINT_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'hint'],
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#67e8f9',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 4, 17, 5.5, 20, 7],
          'line-opacity': 0.46,
          'line-dasharray': [1.5, 1.2],
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_HINT_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_GLOW_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_GLOW_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'main'],
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#22d3ee',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 8, 17, 10, 20, 13],
          'line-opacity': 0.24,
          'line-blur': 0.8,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_GLOW_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_LINE_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_LINE_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'main'],
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#0284c7',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3.25, 17, 4.25, 20, 5.5],
          'line-opacity': 0.98,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_LINE_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_GATE_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_GATE_LAYER_ID,
        type: 'circle',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'gate'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4.5, 17, 5.75, 20, 7],
          'circle-color': '#fefce8',
          'circle-stroke-color': '#ca8a04',
          'circle-stroke-width': 2,
          'circle-opacity': 0.96,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_GATE_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_ORIGIN_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_ORIGIN_LAYER_ID,
        type: 'circle',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'origin'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5.5, 17, 6.5, 20, 8],
          'circle-color': '#0ea5e9',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
          'circle-opacity': 0.98,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_ORIGIN_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_FOCUS_LINE_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_FOCUS_LINE_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'focus-line'],
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#facc15',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 7, 17, 9, 20, 12],
          'line-opacity': 0.9,
          'line-blur': 0.35,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_FOCUS_LINE_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_FOCUS_POINT_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_FOCUS_POINT_LAYER_ID,
        type: 'circle',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'role'], 'focus-point'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 8, 17, 10, 20, 13],
          'circle-color': '#facc15',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
          'circle-opacity': 0.95,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_FOCUS_POINT_LAYER_ID, beforeId);
  }

  const focusArrowFilter: FilterSpecification = [
    'in',
    ['get', 'role'],
    ['literal', ['focus-arrow-body', 'focus-arrow-head']],
  ];

  if (!map.getLayer(ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: focusArrowFilter,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': 'rgba(15, 23, 42, 0.92)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 8, 17, 10.5, 20, 13],
          'line-opacity': 0.98,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: focusArrowFilter,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#2563eb',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 5.8, 17, 7.6, 20, 9.5],
          'line-opacity': 0.98,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID, beforeId);
  }

  if (!map.getLayer(ROUTE_FOCUS_ARROW_INNER_LAYER_ID)) {
    map.addLayer(
      {
        id: ROUTE_FOCUS_ARROW_INNER_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: focusArrowFilter,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 17, 4.6, 20, 5.8],
          'line-opacity': 1,
        },
      },
      beforeId
    );
  } else {
    moveLayerBefore(map, ROUTE_FOCUS_ARROW_INNER_LAYER_ID, beforeId);
  }

  moveLayerToTop(map, ROUTE_GATE_LAYER_ID);
  moveLayerToTop(map, ROUTE_ORIGIN_LAYER_ID);
  moveLayerToTop(map, ROUTE_FOCUS_LINE_LAYER_ID);
  moveLayerToTop(map, ROUTE_FOCUS_POINT_LAYER_ID);
  moveLayerToTop(map, ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID);
  moveLayerToTop(map, ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID);
  moveLayerToTop(map, ROUTE_FOCUS_ARROW_INNER_LAYER_ID);
};

const hasRouteLayers = (map: MapLibreMap): boolean => {
  return Boolean(
      map.getSource(ROUTE_SOURCE_ID) &&
      map.getLayer(ROUTE_HINT_LAYER_ID) &&
      map.getLayer(ROUTE_GLOW_LAYER_ID) &&
      map.getLayer(ROUTE_LINE_LAYER_ID) &&
      map.getLayer(ROUTE_GATE_LAYER_ID) &&
      map.getLayer(ROUTE_ORIGIN_LAYER_ID) &&
      map.getLayer(ROUTE_FOCUS_LINE_LAYER_ID) &&
      map.getLayer(ROUTE_FOCUS_POINT_LAYER_ID) &&
      map.getLayer(ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID) &&
      map.getLayer(ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID) &&
      map.getLayer(ROUTE_FOCUS_ARROW_INNER_LAYER_ID)
  );
};

const collectRouteGateFeatures = (
  routePreview: RoutePreview,
  routingData: RoutingFeatureCollection | null | undefined
): FeatureCollection<LineString | Point>['features'] => {
  const routeNodeIds = new Set(routePreview.graph_node_ids ?? []);
  if (routeNodeIds.size === 0) {
    return [];
  }

  return collectGateFeatures(routingData)
    .filter((feature, index) => routeNodeIds.has(resolveGateNodeId(feature, index)))
    .map((feature, index) => ({
      type: 'Feature',
      properties: {
        role: 'gate',
        gateId: resolveGateNodeId(feature, index),
      },
      geometry: feature.geometry,
    }));
};

const buildRouteCollection = (
  routePreview: RoutePreview,
  routingData?: RoutingFeatureCollection | null,
  focusHighlight?: RouteFocusHighlight | null
): FeatureCollection<LineString | Point> => {
  const remainingPath =
    routePreview.remaining_path && routePreview.remaining_path.length >= 2
      ? routePreview.remaining_path
      : null;

  const geoJsonCoordinates =
    routePreview.path_geojson?.geometry.type === 'LineString'
      ? routePreview.path_geojson.geometry.coordinates
      : null;

  const geoJsonPath: [number, number][] =
    geoJsonCoordinates && geoJsonCoordinates.length >= 2
      ? geoJsonCoordinates
          .map((coordinate) => [Number(coordinate[1]), Number(coordinate[0])] as [number, number])
          .filter((coordinate) => Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]))
      : [];

  const basePath =
    remainingPath && remainingPath.length >= 2
      ? remainingPath
      : geoJsonPath.length >= 2
        ? geoJsonPath
        : routePreview.path;

  let path = basePath;
  let hintPath =
    routePreview.origin_access_hint_path && routePreview.origin_access_hint_path.length >= 2
      ? routePreview.origin_access_hint_path
      : null;

  if (!hintPath && routePreview.route_kind === 'graph' && routePreview.origin_access_point) {
    const accessPoint = routePreview.origin_access_point;
    const accessIndex = basePath.findIndex((point) => nearlySamePoint(point, accessPoint));

    if (accessIndex > 0 && basePath.length - accessIndex >= 2) {
      hintPath = basePath.slice(0, accessIndex + 1);
      path = basePath.slice(accessIndex);
    }
  }

  const features: FeatureCollection<LineString | Point>['features'] = [];

  if (hintPath && hintPath.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { role: 'hint' },
      geometry: {
        type: 'LineString',
        coordinates: hintPath.map(([lat, lng]) => [lng, lat]),
      },
    });
  }

  if (path.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { role: 'main' },
      geometry: {
        type: 'LineString',
        coordinates: path.map(([lat, lng]) => [lng, lat]),
      },
    });
    features.push(...collectRouteGateFeatures(routePreview, routingData));
    features.push({
      type: 'Feature',
      properties: { role: 'origin' },
      geometry: {
        type: 'Point',
        coordinates: [path[0][1], path[0][0]],
      },
    });
  }

  const activeHighlight =
    focusHighlight && focusHighlight.expiresAt > Date.now()
      ? focusHighlight
      : null;

  if (activeHighlight?.path && activeHighlight.path.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { role: 'focus-line', label: activeHighlight.label },
      geometry: {
        type: 'LineString',
        coordinates: activeHighlight.path.map(([lat, lng]) => [lng, lat]),
      },
    });
  }

  if (activeHighlight?.point) {
    features.push({
      type: 'Feature',
      properties: { role: 'focus-point', label: activeHighlight.label },
      geometry: {
        type: 'Point',
        coordinates: [activeHighlight.point[1], activeHighlight.point[0]],
      },
    });
  }

  if (activeHighlight) {
    const arrowGeometry = createGroundArrowGeometry(activeHighlight);

    if (arrowGeometry?.body && arrowGeometry.body.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { role: 'focus-arrow-body', label: activeHighlight.label },
        geometry: {
          type: 'LineString',
          coordinates: arrowGeometry.body.map(([lat, lng]) => [lng, lat]),
        },
      });
    }

    if (arrowGeometry?.head && arrowGeometry.head.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { role: 'focus-arrow-head', label: activeHighlight.label },
        geometry: {
          type: 'LineString',
          coordinates: arrowGeometry.head.map(([lat, lng]) => [lng, lat]),
        },
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
};

const buildDisplayCollection = (
  routePreview: RoutePreview | null,
  routingData?: RoutingFeatureCollection | null,
  focusHighlight?: RouteFocusHighlight | null
): FeatureCollection<LineString | Point> => {
  if (!routePreview) {
    return emptyRouteCollection();
  }

  const collection = buildRouteCollection(routePreview, routingData, focusHighlight);
  return collection.features.length > 0 ? collection : emptyRouteCollection();
};

const syncRouteLayers = (
  map: MapLibreMap,
  routePreview: RoutePreview | null,
  routingData?: RoutingFeatureCollection | null,
  focusHighlight?: RouteFocusHighlight | null
): boolean => {
  if (!map.isStyleLoaded()) {
    return false;
  }

  try {
    const displayCollection = buildDisplayCollection(routePreview, routingData, focusHighlight);
    addSources(map, displayCollection);
    const beforeId = getRouteInsertionLayerId(map);
    addRoadLayer(map, beforeId);
    addRouteLayer(map, beforeId);
    const routeSource = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (!routeSource || !hasRouteLayers(map)) {
      return false;
    }

    routeSource.setData(displayCollection);
    return true;
  } catch (error) {
    console.warn('Route layer sync skipped while map style is settling:', error);
    return false;
  }
};

export const RoutePreviewLayer: React.FC<RoutePreviewLayerProps> = ({
  map,
  routePreview,
  routingData,
  focusHighlight,
}) => {
  const routePreviewRef = useRef<RoutePreview | null>(routePreview);
  const routingDataRef = useRef<RoutingFeatureCollection | null | undefined>(routingData);
  const focusHighlightRef = useRef<RouteFocusHighlight | null | undefined>(focusHighlight);
  const renderedFocusIdsRef = useRef<Set<string>>(new Set());
  const focusClearTimeoutRef = useRef<number | null>(null);
  routePreviewRef.current = routePreview;
  routingDataRef.current = routingData;
  focusHighlightRef.current = focusHighlight;

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    const clearFocusTimeout = (): void => {
      if (focusClearTimeoutRef.current !== null) {
        window.clearTimeout(focusClearTimeoutRef.current);
        focusClearTimeoutRef.current = null;
      }
    };

    const markFocusRendered = (): void => {
      const activeHighlight = focusHighlightRef.current;
      if (!activeHighlight || activeHighlight.expiresAt <= Date.now()) {
        return;
      }

      if (renderedFocusIdsRef.current.has(activeHighlight.id)) {
        return;
      }

      renderedFocusIdsRef.current.add(activeHighlight.id);
      clearFocusTimeout();
      focusClearTimeoutRef.current = window.setTimeout(() => {
        const current = useAppStore.getState().routeFocusHighlight;
        if (current?.id === activeHighlight.id) {
          useAppStore.getState().setRouteFocusHighlight(null);
        }
      }, Math.max(900, activeHighlight.renderDurationMs ?? 2400));
    };

    const ensureRouteLayers = (): void => {
      const synced = syncRouteLayers(
        nativeMap,
        routePreviewRef.current,
        routingDataRef.current,
        focusHighlightRef.current
      );

      if (synced) {
        markFocusRendered();
      }

      if (!nativeMap.isStyleLoaded() || hasRouteLayers(nativeMap)) {
        return;
      }

      window.setTimeout(() => {
        if (!nativeMap.isStyleLoaded() || hasRouteLayers(nativeMap)) {
          return;
        }

        const retrySynced = syncRouteLayers(
          nativeMap,
          routePreviewRef.current,
          routingDataRef.current,
          focusHighlightRef.current
        );
        if (retrySynced) {
          markFocusRendered();
        }
      }, 120);
    };

    const scheduleRouteLayerSync = (): void => {
      ensureRouteLayers();
      window.requestAnimationFrame(ensureRouteLayers);
      ROUTE_LAYER_RETRY_DELAYS_MS.forEach((delayMs) => {
        window.setTimeout(ensureRouteLayers, delayMs);
      });
    };

    const cleanupLoad = map.on('load', ensureRouteLayers);
    const cleanupStyle = map.on('styledata', ensureRouteLayers);
    const cleanupMoveEnd = map.on('moveend', ensureRouteLayers);
    nativeMap.on('style.load', ensureRouteLayers);
    nativeMap.on('idle', ensureRouteLayers);
    scheduleRouteLayerSync();

    return (): void => {
      clearFocusTimeout();
      cleanupLoad();
      cleanupStyle();
      cleanupMoveEnd();
      nativeMap.off('style.load', ensureRouteLayers);
      nativeMap.off('idle', ensureRouteLayers);
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      if (nativeMap.getLayer(ROUTE_ORIGIN_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_ORIGIN_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_FOCUS_ARROW_INNER_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_FOCUS_ARROW_INNER_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_FOCUS_ARROW_CONTRAST_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_FOCUS_ARROW_OUTLINE_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_FOCUS_POINT_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_FOCUS_POINT_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_FOCUS_LINE_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_FOCUS_LINE_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_LINE_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_LINE_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_GATE_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_GATE_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_GLOW_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_GLOW_LAYER_ID);
      }
      if (nativeMap.getLayer(ROUTE_HINT_LAYER_ID)) {
        nativeMap.removeLayer(ROUTE_HINT_LAYER_ID);
      }
      if (nativeMap.getLayer(CUSTOM_ROADS_LAYER_ID)) {
        nativeMap.removeLayer(CUSTOM_ROADS_LAYER_ID);
      }
      if (nativeMap.getSource(ROUTE_SOURCE_ID)) {
        nativeMap.removeSource(ROUTE_SOURCE_ID);
      }
      if (nativeMap.getSource(CUSTOM_ROADS_SOURCE_ID)) {
        nativeMap.removeSource(CUSTOM_ROADS_SOURCE_ID);
      }
    };
  }, [map]);

  useEffect(() => {
    routePreviewRef.current = routePreview;
    routingDataRef.current = routingData;
    focusHighlightRef.current = focusHighlight;

    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    const clearRenderedFocus = (): void => {
      if (!focusHighlight) {
        renderedFocusIdsRef.current.clear();
      }
    };
    clearRenderedFocus();

    const markFocusRendered = (): void => {
      if (!focusHighlight || focusHighlight.expiresAt <= Date.now()) {
        return;
      }

      if (renderedFocusIdsRef.current.has(focusHighlight.id)) {
        return;
      }

      renderedFocusIdsRef.current.add(focusHighlight.id);
      if (focusClearTimeoutRef.current !== null) {
        window.clearTimeout(focusClearTimeoutRef.current);
      }
      focusClearTimeoutRef.current = window.setTimeout(() => {
        const current = useAppStore.getState().routeFocusHighlight;
        if (current?.id === focusHighlight.id) {
          useAppStore.getState().setRouteFocusHighlight(null);
        }
      }, Math.max(900, focusHighlight.renderDurationMs ?? 2400));
    };

    if (syncRouteLayers(nativeMap, routePreview, routingData, focusHighlight)) {
      markFocusRendered();
    }
    window.requestAnimationFrame(() => {
      if (syncRouteLayers(nativeMap, routePreviewRef.current, routingDataRef.current, focusHighlightRef.current)) {
        markFocusRendered();
      }
    });
    const retryIds = ROUTE_LAYER_RETRY_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        if (syncRouteLayers(nativeMap, routePreviewRef.current, routingDataRef.current, focusHighlightRef.current)) {
          markFocusRendered();
        }
      }, delayMs)
    );

    return () => {
      retryIds.forEach((retryId) => window.clearTimeout(retryId));
    };
  }, [focusHighlight, map, routePreview, routingData]);

  return null;
};

export default RoutePreviewLayer;
