import { useEffect } from 'react';
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { useAppStore } from '../store/useAppStore';
import type { MapEngineAdapter } from './mapEngineTypes';
import { resolveFeatureAnchorCoordinates, resolveFeatureId, resolveFeatureVisualClass } from './geoGeometry';

interface FeatureProperties {
  type?: string;
  [key: string]: unknown;
}

type CampusFeature = Feature<Geometry, FeatureProperties>;
type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;

interface MarkerLayerProps {
  map: MapEngineAdapter | null;
  geojsonData?: CampusCollection | null;
  dimAcademic?: boolean;
}

const SELECTED_SOURCE_ID = 'wia-selected-location';
const SELECTED_HALO_LAYER_ID = 'wia-selected-location-halo';
const SELECTED_CORE_LAYER_ID = 'wia-selected-location-core';

const SHARED_SOURCE_ID = 'wia-shared-location';
const SHARED_HALO_LAYER_ID = 'wia-shared-location-halo';
const SHARED_CORE_LAYER_ID = 'wia-shared-location-core';


const emptySelectedCollection = (): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: [],
});

const buildSelectedCollection = (
  coordinates: [number, number] | null,
  isSos = false

): FeatureCollection<Point, { selected: true; sos: boolean }> => ({

  type: 'FeatureCollection',
  features: coordinates
    ? [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [coordinates[1], coordinates[0]],
          },
          properties: {
            selected: true,
            sos: isSos,

          },
        },
      ]
    : [],
});

const resolveSelectedCoordinates = (
  selectedLocation: ReturnType<typeof useAppStore.getState>['selectedLocation'],
  geojsonData?: CampusCollection | null
): [number, number] | null => {
  if (!selectedLocation) {
    return null;
  }

  const selectedFeature = geojsonData?.features?.find(
    (feature, index) => resolveFeatureId(feature, index) === selectedLocation.id
  );

  return selectedFeature ? resolveFeatureAnchorCoordinates(selectedFeature) : selectedLocation.coordinates;
};

const setSourceData = (nativeMap: MapLibreMap, sourceId: string, data: FeatureCollection<Point>): void => {
  const source = nativeMap.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
};

const ensureSelectedLayers = (nativeMap: MapLibreMap): void => {
  if (!nativeMap.getSource(SELECTED_SOURCE_ID)) {
    nativeMap.addSource(SELECTED_SOURCE_ID, {
      type: 'geojson',
      data: emptySelectedCollection(),
    });
  }

  if (!nativeMap.getLayer(SELECTED_HALO_LAYER_ID)) {
    nativeMap.addLayer({
      id: SELECTED_HALO_LAYER_ID,
      type: 'circle',
      source: SELECTED_SOURCE_ID,
      paint: {
        'circle-color': '#38bdf8',
        'circle-opacity': 0.28,
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          13,
          17,
          18,
          20,
          22,
        ],
        'circle-stroke-color': '#f0f9ff',
        'circle-stroke-opacity': 0.78,
        'circle-stroke-width': 2.2,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    });
  }

  if (!nativeMap.getLayer(SELECTED_CORE_LAYER_ID)) {
    nativeMap.addLayer({
      id: SELECTED_CORE_LAYER_ID,
      type: 'circle',
      source: SELECTED_SOURCE_ID,
      paint: {
        'circle-color': '#0ea5e9',
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          5.5,
          17,
          6.5,
          20,
          8.5,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 4,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    });
  }
};

const ensureSharedLayers = (nativeMap: MapLibreMap): void => {
  if (!nativeMap.getSource(SHARED_SOURCE_ID)) {
    nativeMap.addSource(SHARED_SOURCE_ID, {
      type: 'geojson',
      data: emptySelectedCollection(),
    });
  }

  if (!nativeMap.getLayer(SHARED_HALO_LAYER_ID)) {
    nativeMap.addLayer({
      id: SHARED_HALO_LAYER_ID,
      type: 'circle',
      source: SHARED_SOURCE_ID,
      paint: {
        'circle-color': ['case', ['get', 'sos'], '#f43f5e', '#0ea5e9'],
        'circle-opacity': 0.25,
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          12,
          17,
          20,
          20,
          28,
        ],
        'circle-stroke-color': ['case', ['get', 'sos'], '#fda4af', '#7dd3fc'],
        'circle-stroke-opacity': 0.5,
        'circle-stroke-width': 3,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    });
  }

  if (!nativeMap.getLayer(SHARED_CORE_LAYER_ID)) {
    nativeMap.addLayer({
      id: SHARED_CORE_LAYER_ID,
      type: 'circle',
      source: SHARED_SOURCE_ID,
      paint: {
        'circle-color': ['case', ['get', 'sos'], '#e11d48', '#0284c7'],
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          6,
          17,
          9,
          20,
          12,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    });
  }
};

const syncLayerPlacement = (nativeMap: MapLibreMap): void => {
  [
    SELECTED_HALO_LAYER_ID,
    SELECTED_CORE_LAYER_ID,
    SHARED_HALO_LAYER_ID,
    SHARED_CORE_LAYER_ID,
  ].forEach((layerId) => {
    if (nativeMap.getLayer(layerId)) {
      nativeMap.moveLayer(layerId);
    }
  });
};

export const MarkerLayer: React.FC<MarkerLayerProps> = ({ map, geojsonData }) => {
  const selectedLocation = useAppStore((state) => state.selectedLocation);
  const sharedIntent = useAppStore((state) => state.sharedIntent);

  const setAllCategories = useAppStore((state) => state.setAllCategories);

  useEffect(() => {
    const categories = Array.from(
      new Set(
        (geojsonData?.features ?? [])
          .filter((feature: CampusFeature) => {
            const geometryType = feature.geometry?.type;
            if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
              return false;
            }

            return resolveFeatureVisualClass(feature) === 'structure';
          })
          .map((feature: CampusFeature) => feature.properties?.type)
          .filter(
            (category): category is string =>
              typeof category === 'string' &&
              category.trim().length > 0 &&
              category.trim().toLowerCase() !== 'location' &&
              category.trim().toLowerCase() !== 'unknown'
          )
      )
    ).sort((left, right) => left.localeCompare(right));

    setAllCategories(categories);
  }, [geojsonData, setAllCategories]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    const syncMarkers = (): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      ensureSelectedLayers(nativeMap);
      ensureSharedLayers(nativeMap);
      syncLayerPlacement(nativeMap);

      setSourceData(
        nativeMap,
        SELECTED_SOURCE_ID,
        buildSelectedCollection(resolveSelectedCoordinates(selectedLocation, geojsonData))
      );

      setSourceData(
        nativeMap,
        SHARED_SOURCE_ID,
        buildSelectedCollection(sharedIntent?.coordinates ?? null, sharedIntent?.isSos ?? false)
      );
    };

    const scheduleMarkerSync = (): void => {
      syncMarkers();
      window.requestAnimationFrame(syncMarkers);
      window.setTimeout(syncMarkers, 60);
      window.setTimeout(syncMarkers, 180);
    };

    scheduleMarkerSync();
    nativeMap.on('load', syncMarkers);
    nativeMap.on('styledata', syncMarkers);
    nativeMap.on('idle', syncMarkers);

    return (): void => {
      nativeMap.off('load', syncMarkers);
      nativeMap.off('styledata', syncMarkers);
      nativeMap.off('idle', syncMarkers);
    };
  }, [geojsonData, map, selectedLocation, sharedIntent]);

  return null;
};

export default MarkerLayer;
