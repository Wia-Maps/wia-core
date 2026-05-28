import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { clientConfig } from '../config/client';
import { useAppStore } from '../store/useAppStore';
import type { MapEngineAdapter, MapViewMode } from './mapEngineTypes';
import { featureBoundaryPointNearestToPoint, resolveFeatureAnchorCoordinates, resolveFeatureId } from './geoGeometry';
import { matchesLocationFilters } from './locationFilters';
import { isBoundaryFeature } from './geoGeometry';
import { enrichCollectionWithExtrusionHeight } from './mapStyle';

interface FeatureProperties {
  id?: string;
  name?: string;
  type?: string;
  __featureClass?: 'structure' | 'surface' | 'fence';
  __surfaceKind?: string | null;
  __height_m?: number;
  __surfaceHeight_m?: number;
  __isVisible?: boolean;
  __isSelected?: boolean;
  __isStructure?: boolean;
  __isSurface?: boolean;
  __isFence?: boolean;
  __shouldDim?: boolean;
  [key: string]: unknown;
}

type CampusFeature = Feature<Geometry, FeatureProperties>;
type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;
type CampusPointCollection = FeatureCollection<Point, Record<string, unknown>>;

interface LocationOutlineLayerProps {
  map: MapEngineAdapter | null;
  geojsonData?: CampusCollection | null;
  dimAcademic?: boolean;
  viewMode?: MapViewMode;
}

const LOCATION_SOURCE_ID = 'wia-locations';
const LOCATION_STRUCTURE_SHADOW_LAYER_ID = 'wia-locations-structure-shadow';
const LOCATION_STRUCTURE_FILL_LAYER_ID = 'wia-locations-structure-fill';
const LOCATION_STRUCTURE_EXTRUSION_LAYER_ID = 'wia-locations-structure-extrusion';
const LOCATION_STRUCTURE_ROOF_LAYER_ID = 'wia-locations-structure-roof';
const LOCATION_STRUCTURE_WINDOWS_LAYER_ID = 'wia-locations-structure-windows';
const LOCATION_STRUCTURE_DOORS_LAYER_ID = 'wia-locations-structure-doors';
const LOCATION_STRUCTURE_OUTLINE_LAYER_ID = 'wia-locations-structure-outline';
const LOCATION_SURFACE_FILL_LAYER_ID = 'wia-locations-surface-fill';
const LOCATION_SURFACE_OUTLINE_LAYER_ID = 'wia-locations-surface-outline';
const LOCATION_FENCE_FILL_LAYER_ID = 'wia-locations-fence-fill';
const LOCATION_FENCE_WALL_LAYER_ID = 'wia-locations-fence-wall';
const LOCATION_FENCE_OUTLINE_LAYER_ID = 'wia-locations-fence-outline';
const LOCATION_HOVER_LAYER_ID = 'wia-locations-hover';
const LOCATION_SELECTED_LAYER_ID = 'wia-locations-selected';
const LOCATION_ENTRY_SOURCE_ID = 'wia-location-entry';
const LOCATION_ENTRY_LAYER_ID = 'wia-location-entry-cue';
const SELECTED_MARKER_LAYER_IDS = [
  'wia-selected-location-halo',
  'wia-selected-location-core',
  'wia-shared-location-halo',
  'wia-shared-location-core',
] as const;

const STRUCTURE_FILL_COLOR = '#dbe8ee';
const STRUCTURE_FILL_SELECTED_COLOR = '#a6e6f4';
const STRUCTURE_FILL_DIM_COLOR = '#eef4f7';
const STRUCTURE_EXTRUSION_COLOR = '#6b7785';
const STRUCTURE_EXTRUSION_SELECTED_COLOR = '#167fa3';
const STRUCTURE_ROOF_COLOR = '#d8e5ee';
const STRUCTURE_ROOF_SELECTED_COLOR = '#92ddf0';
const STRUCTURE_ROOF_DIM_COLOR = '#e2e9ee';
const STRUCTURE_OUTLINE_COLOR = '#0f172a';
const STRUCTURE_OUTLINE_SELECTED_COLOR = '#0f766e';
const SURFACE_OUTLINE_COLOR = '#5b6670';
const SURFACE_SELECTED_OUTLINE_COLOR = '#0f766e';
const STRUCTURE_SHADOW_COLOR = '#0f172a';
const FENCE_FILL_COLOR = '#d6e1e6';
const FENCE_FILL_SELECTED_COLOR = '#c5d7de';
const FENCE_WALL_COLOR = '#6b7785';
const FENCE_WALL_SELECTED_COLOR = '#4f6472';
const FENCE_OUTLINE_COLOR = '#334155';
const FENCE_OUTLINE_SELECTED_COLOR = '#0f172a';
const STRUCTURE_ROOF_CAP_M = 0.85;
const STRUCTURE_3D_HEIGHT_SCALE = 3.2;
const FENCE_WALL_HEIGHT_M = 1.35;
const EMPTY_COLLECTION: CampusCollection = {
  type: 'FeatureCollection',
  features: [],
};
const LOCATION_STRUCTURE_INTERACTIVE_LAYER_IDS = [
  LOCATION_STRUCTURE_DOORS_LAYER_ID,
  LOCATION_STRUCTURE_WINDOWS_LAYER_ID,
  LOCATION_STRUCTURE_ROOF_LAYER_ID,
  LOCATION_STRUCTURE_EXTRUSION_LAYER_ID,
  LOCATION_STRUCTURE_FILL_LAYER_ID,
] as const;
const LOCATION_SECONDARY_INTERACTIVE_LAYER_IDS = [
  LOCATION_SURFACE_FILL_LAYER_ID,
  LOCATION_FENCE_WALL_LAYER_ID,
  LOCATION_FENCE_OUTLINE_LAYER_ID,
  LOCATION_FENCE_FILL_LAYER_ID,
] as const;
const LOCATION_LAYER_REMOVAL_ORDER = [
  LOCATION_ENTRY_LAYER_ID,
  LOCATION_SELECTED_LAYER_ID,
  LOCATION_HOVER_LAYER_ID,
  LOCATION_FENCE_OUTLINE_LAYER_ID,
  LOCATION_FENCE_WALL_LAYER_ID,
  LOCATION_FENCE_FILL_LAYER_ID,
  LOCATION_SURFACE_OUTLINE_LAYER_ID,
  LOCATION_SURFACE_FILL_LAYER_ID,
  LOCATION_STRUCTURE_OUTLINE_LAYER_ID,
  LOCATION_STRUCTURE_DOORS_LAYER_ID,
  LOCATION_STRUCTURE_WINDOWS_LAYER_ID,
  LOCATION_STRUCTURE_ROOF_LAYER_ID,
  LOCATION_STRUCTURE_EXTRUSION_LAYER_ID,
  LOCATION_STRUCTURE_FILL_LAYER_ID,
  LOCATION_STRUCTURE_SHADOW_LAYER_ID,
] as const;

const isPolygonFeature = (feature: CampusFeature | null | undefined): feature is CampusFeature => {
  const geometryType = feature?.geometry?.type;
  return geometryType === 'Polygon' || geometryType === 'MultiPolygon';
};

const isFenceFeature = (feature: CampusFeature | null | undefined): boolean => {
  return isBoundaryFeature(feature);
};

const getCampusFeatureId = (feature: CampusFeature, fallback?: number | string): string => {
  return resolveFeatureId(feature, fallback) ?? (typeof fallback === 'number' ? `feature_${fallback}` : 'unknown_location');
};

const readFeatureIdProperty = (feature: CampusFeature | null | undefined): string | null => {
  const value = feature?.properties?.__featureId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const readCampusFeatureId = (feature: CampusFeature | null | undefined, fallback?: number | string): string | null => {
  return readFeatureIdProperty(feature) ?? (feature ? getCampusFeatureId(feature, fallback) : null);
};

const getStructureHeightExpressions = (viewMode: MapViewMode): { visualStructureHeightExpression: any; wallHeightExpression: any } => {
  const isFlatMode = viewMode === 'flat';
  const structureHeightExpression: any = [
    'coalesce',
    ['get', '__height_m'],
    clientConfig.map.structureFallbackHeightM ?? 3.5,
  ];
  const visualStructureHeightExpression: any = isFlatMode
    ? structureHeightExpression
    : ['*', structureHeightExpression, STRUCTURE_3D_HEIGHT_SCALE];

  return {
    visualStructureHeightExpression,
    wallHeightExpression: ['max', ['-', visualStructureHeightExpression, STRUCTURE_ROOF_CAP_M], 0],
  };
};

const buildStructureShadowOpacity = (viewMode: MapViewMode): any => {
  const isFlatMode = viewMode === 'flat';
  return [
    'case',
    ['boolean', ['get', '__isSelected'], false],
    isFlatMode ? 0 : 0.2,
    ['!', ['boolean', ['get', '__isVisible'], false]],
    0,
    ['boolean', ['get', '__shouldDim'], false],
    isFlatMode ? 0 : 0.06,
    isFlatMode ? 0 : 0.14,
  ];
};

const buildStructureFillOpacity = (viewMode: MapViewMode): any => {
  const isFlatMode = viewMode === 'flat';
  return [
    'case',
    ['boolean', ['get', '__isSelected'], false],
    isFlatMode ? 0.58 : 0.08,
    ['!', ['boolean', ['get', '__isVisible'], false]],
    0.0,
    ['boolean', ['get', '__shouldDim'], false],
    isFlatMode ? 0.22 : 0.04,
    isFlatMode ? 0.42 : 0.06,
  ];
};

const buildStructureOutlineColor = (viewMode: MapViewMode): any => {
  const isFlatMode = viewMode === 'flat';
  return [
    'case',
    ['boolean', ['get', '__isSelected'], false],
    STRUCTURE_OUTLINE_SELECTED_COLOR,
    ['boolean', ['get', '__isVisible'], false],
    STRUCTURE_OUTLINE_COLOR,
    isFlatMode ? '#0f172a' : '#94a3b8',
  ];
};

const buildStructureOutlineWidth = (viewMode: MapViewMode): any => {
  const isFlatMode = viewMode === 'flat';
  if (!isFlatMode) {
    return 0;
  }

  return [
    'case',
    ['boolean', ['get', '__isSelected'], false],
    2.2,
    ['boolean', ['get', '__shouldDim'], false],
    1.4,
    1.7,
  ];
};

const buildStructureOutlineOpacity = (viewMode: MapViewMode): any => {
  const isFlatMode = viewMode === 'flat';
  if (!isFlatMode) {
    return 0;
  }

  return [
    'case',
    ['boolean', ['get', '__isSelected'], false],
    0.97,
    ['!', ['boolean', ['get', '__isVisible'], false]],
    0.0,
    ['boolean', ['get', '__shouldDim'], false],
    0.82,
    0.92,
  ];
};

const buildSurfaceFillOpacity = (viewMode: MapViewMode): any => {
  const isFlatMode = viewMode === 'flat';
  return [
    'case',
    ['boolean', ['get', '__isSelected'], false],
    isFlatMode ? 0.28 : 0.32,
    ['!', ['boolean', ['get', '__isVisible'], false]],
    0,
    ['boolean', ['get', '__shouldDim'], false],
    isFlatMode ? 0.12 : 0.2,
    isFlatMode ? 0.2 : 0.28,
  ];
};

const syncHoverFilter = (nativeMap: MapEngineAdapter['nativeMap'], hoveredFeatureId: string): void => {
  if (nativeMap.getLayer(LOCATION_HOVER_LAYER_ID)) {
    nativeMap.setFilter(LOCATION_HOVER_LAYER_ID, ['==', ['get', '__featureId'], hoveredFeatureId]);
  }
};

const syncSelectionMarkerPlacement = (nativeMap: MapEngineAdapter['nativeMap']): void => {
  SELECTED_MARKER_LAYER_IDS.forEach((layerId) => {
    if (nativeMap.getLayer(layerId)) {
      nativeMap.moveLayer(layerId);
    }
  });
};

const syncLocationLayerPaints = (nativeMap: MapEngineAdapter['nativeMap'], viewMode: MapViewMode): void => {
  const isFlatMode = viewMode === 'flat';
  const { visualStructureHeightExpression, wallHeightExpression } = getStructureHeightExpressions(viewMode);
  const updates: Array<[string, string, unknown]> = [
    [LOCATION_STRUCTURE_SHADOW_LAYER_ID, 'fill-opacity', buildStructureShadowOpacity(viewMode)],
    [LOCATION_STRUCTURE_SHADOW_LAYER_ID, 'fill-translate', isFlatMode ? [0, 0] : [3, 3]],
    [LOCATION_STRUCTURE_FILL_LAYER_ID, 'fill-opacity', buildStructureFillOpacity(viewMode)],
    [LOCATION_STRUCTURE_EXTRUSION_LAYER_ID, 'fill-extrusion-height', wallHeightExpression],
    [LOCATION_STRUCTURE_EXTRUSION_LAYER_ID, 'fill-extrusion-base', 0],
    [LOCATION_STRUCTURE_EXTRUSION_LAYER_ID, 'fill-extrusion-opacity', isFlatMode ? 0 : 0.96],
    [LOCATION_STRUCTURE_ROOF_LAYER_ID, 'fill-extrusion-base', wallHeightExpression],
    [LOCATION_STRUCTURE_ROOF_LAYER_ID, 'fill-extrusion-height', visualStructureHeightExpression],
    [LOCATION_STRUCTURE_ROOF_LAYER_ID, 'fill-extrusion-opacity', isFlatMode ? 0 : 0.98],
    [LOCATION_STRUCTURE_WINDOWS_LAYER_ID, 'fill-extrusion-base', ['max', ['+', wallHeightExpression, -2.2], 0.4]],
    [LOCATION_STRUCTURE_WINDOWS_LAYER_ID, 'fill-extrusion-height', ['max', ['-', wallHeightExpression, 0.2], 0]],
    [LOCATION_STRUCTURE_WINDOWS_LAYER_ID, 'fill-extrusion-opacity', isFlatMode ? 0 : 0.28],
    [LOCATION_STRUCTURE_DOORS_LAYER_ID, 'fill-extrusion-opacity', isFlatMode ? 0 : 0.42],
    [LOCATION_STRUCTURE_OUTLINE_LAYER_ID, 'line-color', buildStructureOutlineColor(viewMode)],
    [LOCATION_STRUCTURE_OUTLINE_LAYER_ID, 'line-width', buildStructureOutlineWidth(viewMode)],
    [LOCATION_STRUCTURE_OUTLINE_LAYER_ID, 'line-opacity', buildStructureOutlineOpacity(viewMode)],
    [LOCATION_SURFACE_FILL_LAYER_ID, 'fill-opacity', buildSurfaceFillOpacity(viewMode)],
    [LOCATION_FENCE_FILL_LAYER_ID, 'fill-opacity', [
      'case',
      ['boolean', ['get', '__isSelected'], false],
      isFlatMode ? 0.18 : 0.06,
      ['!', ['boolean', ['get', '__isVisible'], false]],
      0,
      ['boolean', ['get', '__shouldDim'], false],
      isFlatMode ? 0.08 : 0.03,
      isFlatMode ? 0.12 : 0.04,
    ]],
    [LOCATION_FENCE_WALL_LAYER_ID, 'fill-extrusion-height', FENCE_WALL_HEIGHT_M],
    [LOCATION_FENCE_WALL_LAYER_ID, 'fill-extrusion-base', 0],
    [LOCATION_FENCE_WALL_LAYER_ID, 'fill-extrusion-opacity', isFlatMode ? 0 : 0.48],
    [LOCATION_FENCE_OUTLINE_LAYER_ID, 'line-width', [
      'case',
      ['boolean', ['get', '__isSelected'], false],
      isFlatMode ? 2.1 : 1.25,
      isFlatMode ? 1.35 : 0.9,
    ]],
    [LOCATION_FENCE_OUTLINE_LAYER_ID, 'line-opacity', isFlatMode ? 0.88 : 0.62],
    [LOCATION_HOVER_LAYER_ID, 'line-width', isFlatMode ? 2.6 : 0],
    [LOCATION_HOVER_LAYER_ID, 'line-opacity', isFlatMode ? 0.95 : 0],
    [LOCATION_SELECTED_LAYER_ID, 'line-width', isFlatMode ? 3.2 : 0],
    [LOCATION_SELECTED_LAYER_ID, 'line-opacity', isFlatMode ? 0.96 : 0],
  ];

  updates.forEach(([layerId, property, value]) => {
    const layerExists = Boolean(nativeMap.getLayer(layerId));
    if (layerExists) {
      nativeMap.setPaintProperty(layerId, property, value as any);
    }
  });
};

const removeLocationLayers = (nativeMap: MapEngineAdapter['nativeMap']): void => {
  LOCATION_LAYER_REMOVAL_ORDER.forEach((layerId) => {
    if (nativeMap.getLayer(layerId)) {
      nativeMap.removeLayer(layerId);
    }
  });

  if (nativeMap.getSource(LOCATION_SOURCE_ID)) {
    nativeMap.removeSource(LOCATION_SOURCE_ID);
  }

  if (nativeMap.getSource(LOCATION_ENTRY_SOURCE_ID)) {
    nativeMap.removeSource(LOCATION_ENTRY_SOURCE_ID);
  }
};

const getInteractiveFeatureAtPoint = (
  nativeMap: MapEngineAdapter['nativeMap'],
  point: MapMouseEvent['point']
): CampusFeature | null => {
  const findFeatureInLayers = (layerIds: readonly string[]): CampusFeature | null => {
    const layers = layerIds.filter((layerId) => Boolean(nativeMap.getLayer(layerId)));
    if (layers.length === 0) {
      return null;
    }

    const feature = nativeMap.queryRenderedFeatures(point, { layers: [...layers] }).find((candidate) => {
      const campusFeature = candidate as unknown as CampusFeature;
      return isPolygonFeature(campusFeature) && Boolean(readCampusFeatureId(campusFeature));
    });

    return feature ? (feature as unknown as CampusFeature) : null;
  };

  return (
    findFeatureInLayers(LOCATION_STRUCTURE_INTERACTIVE_LAYER_IDS) ??
    findFeatureInLayers(LOCATION_SECONDARY_INTERACTIVE_LAYER_IDS)
  );
};

const getFeatureFallbackCoordinates = (feature: CampusFeature): [number, number] => {
  return resolveFeatureAnchorCoordinates(feature);
};

const buildStyledCollection = (
  geojsonData: CampusCollection,
  activeFilters: string[],
  selectedLocationId: string | null,
  dimAcademic: boolean
): CampusCollection => {
  const polygonOnly: CampusCollection = {
    ...geojsonData,
    features: geojsonData.features
      .filter((feature): feature is CampusFeature => isPolygonFeature(feature))
      .map((feature, index) => {
        const category = String(feature.properties?.type ?? 'Unknown');
        const featureId = getCampusFeatureId(feature, index);
        const isVisible = matchesLocationFilters(category, activeFilters);
        const isSelected = selectedLocationId === featureId;
        const shouldDim = dimAcademic && category.toLowerCase() === 'academic';

        return {
          ...feature,
          properties: {
            ...(feature.properties ?? {}),
            __featureId: featureId,
            __category: category,
            __isFence: isFenceFeature(feature),
            __isVisible: isVisible,
            __isSelected: isSelected,
            __shouldDim: shouldDim,
          },
        };
      }),
  };

  return enrichCollectionWithExtrusionHeight(polygonOnly as FeatureCollection<Geometry, Record<string, unknown>>) as CampusCollection;
};

const buildSelectedEntranceCollection = (
  selectedFeature: CampusFeature | null,
  selectedLocationCoordinates: [number, number] | null
): CampusPointCollection => {
  if (selectedFeature?.properties?.__isStructure !== true) {
    return {
      type: 'FeatureCollection',
      features: [],
    };
  }

  const entrancePoint =
    selectedFeature && selectedLocationCoordinates
      ? featureBoundaryPointNearestToPoint(selectedFeature, selectedLocationCoordinates)
      : null;

  if (!entrancePoint) {
    return {
      type: 'FeatureCollection',
      features: [],
    };
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [entrancePoint[0], entrancePoint[1]],
        },
        properties: {
          kind: 'entrance',
        },
      },
    ],
  };
};

export const LocationOutlineLayer: React.FC<LocationOutlineLayerProps> = ({
  map,
  geojsonData,
  dimAcademic = false,
  viewMode = 'flat',
}) => {
  useEffect(() => {
    // no-op: viewMode prop change handled via ref and paint sync
  }, [viewMode]);
  const activeFilters = useAppStore((state) => state.activeFilters);
  const selectedLocation = useAppStore((state) => state.selectedLocation);
  const selectLocation = useAppStore((state) => state.selectLocation);
  const openBottomSheet = useAppStore((state) => state.openBottomSheet);
  const [previewFeatureId, setPreviewFeatureId] = useState<string | null>(null);
  const previewFeatureIdRef = useRef<string | null>(previewFeatureId);

  const collection = useMemo(() => {
    if (!geojsonData?.features) {
      return null;
    }

    return buildStyledCollection(
      geojsonData,
      activeFilters,
      previewFeatureId ?? selectedLocation?.id ?? null,
      dimAcademic
    );
  }, [activeFilters, dimAcademic, geojsonData, previewFeatureId, selectedLocation?.id]);

  const selectedFeature = useMemo(() => {
    if (!collection?.features?.length || !selectedLocation?.id) {
      return null;
    }

    return collection.features.find((feature) => readCampusFeatureId(feature) === selectedLocation.id) ?? null;
  }, [collection, selectedLocation?.id]);

  const selectedEntranceCollection = useMemo(() => {
    return buildSelectedEntranceCollection(selectedFeature, selectedLocation?.coordinates ?? null);
  }, [selectedFeature, selectedLocation?.coordinates]);
  const collectionRef = useRef<CampusCollection | null>(collection);
  const selectedEntranceCollectionRef = useRef<CampusPointCollection>(selectedEntranceCollection);
  const selectedLocationRef = useRef(selectedLocation);
  const selectLocationRef = useRef(selectLocation);
  const openBottomSheetRef = useRef(openBottomSheet);
  const viewModeRef = useRef(viewMode);
  const hoveredFeatureIdRef = useRef('');

  collectionRef.current = collection;
  selectedEntranceCollectionRef.current = selectedEntranceCollection;
  selectedLocationRef.current = selectedLocation;
  selectLocationRef.current = selectLocation;
  openBottomSheetRef.current = openBottomSheet;
  viewModeRef.current = viewMode;
  previewFeatureIdRef.current = previewFeatureId;

  useEffect(() => {
    setPreviewFeatureId(null);
  }, [selectedLocation?.id]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    if (!nativeMap.isStyleLoaded()) {
      return;
    }

    const source = nativeMap.getSource(LOCATION_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(collection ?? EMPTY_COLLECTION);
  }, [collection, map]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap || !nativeMap.isStyleLoaded()) {
      return;
    }

    const source = nativeMap.getSource(LOCATION_ENTRY_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(selectedEntranceCollection);
  }, [map, selectedEntranceCollection]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap) {
      return;
    }

    const hasInitializedLayers = (): boolean => {
      return Boolean(
        nativeMap.getSource(LOCATION_SOURCE_ID) &&
        nativeMap.getSource(LOCATION_ENTRY_SOURCE_ID) &&
        nativeMap.getLayer(LOCATION_STRUCTURE_FILL_LAYER_ID) &&
        nativeMap.getLayer(LOCATION_SURFACE_FILL_LAYER_ID)
      );
    };

    const initializeLayers = (): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      if (!nativeMap.getSource(LOCATION_SOURCE_ID)) {
        nativeMap.addSource(LOCATION_SOURCE_ID, {
          type: 'geojson',
          data: collectionRef.current ?? EMPTY_COLLECTION,
        });
      } else {
        const source = nativeMap.getSource(LOCATION_SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData(collectionRef.current ?? EMPTY_COLLECTION);
      }

      if (!nativeMap.getSource(LOCATION_ENTRY_SOURCE_ID)) {
        nativeMap.addSource(LOCATION_ENTRY_SOURCE_ID, {
          type: 'geojson',
          data: selectedEntranceCollectionRef.current,
        });
      } else {
        const entrySource = nativeMap.getSource(LOCATION_ENTRY_SOURCE_ID) as GeoJSONSource | undefined;
        entrySource?.setData(selectedEntranceCollectionRef.current);
      }

      const visibleOrSelectedFilter: any = [
        'any',
        ['boolean', ['get', '__isVisible'], false],
        ['boolean', ['get', '__isSelected'], false],
      ];
      const isFlatMode = viewModeRef.current === 'flat';
      // initialization debug removed in cleanup
      const structureHeightExpression: any = [
        'coalesce',
        ['get', '__height_m'],
        clientConfig.map.structureFallbackHeightM ?? 3.5,
      ];
      const visualStructureHeightExpression: any = isFlatMode
        ? structureHeightExpression
        : ['*', structureHeightExpression, STRUCTURE_3D_HEIGHT_SCALE];
      const wallHeightExpression: any = [
        'max',
        ['-', visualStructureHeightExpression, STRUCTURE_ROOF_CAP_M],
        0,
      ];

      if (!nativeMap.getLayer(LOCATION_STRUCTURE_SHADOW_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_SHADOW_LAYER_ID,
          type: 'fill',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'fill-color': STRUCTURE_SHADOW_COLOR,
            'fill-opacity': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              isFlatMode ? 0 : 0.16,
              ['!', ['boolean', ['get', '__isVisible'], false]],
              0,
              ['boolean', ['get', '__shouldDim'], false],
              isFlatMode ? 0 : 0.03,
              isFlatMode ? 0 : 0.09,
            ],
            'fill-translate': isFlatMode ? [0, 0] : [3, 3],
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_STRUCTURE_FILL_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_FILL_LAYER_ID,
          type: 'fill',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'fill-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              STRUCTURE_FILL_SELECTED_COLOR,
              ['boolean', ['get', '__shouldDim'], false],
              STRUCTURE_FILL_DIM_COLOR,
              STRUCTURE_FILL_COLOR,
            ],
            'fill-opacity': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              isFlatMode ? 0.38 : 0,
              ['!', ['boolean', ['get', '__isVisible'], false]],
              0.0,
              ['boolean', ['get', '__shouldDim'], false],
              isFlatMode ? 0.14 : 0,
              isFlatMode ? 0.28 : 0,
            ],
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_STRUCTURE_EXTRUSION_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_EXTRUSION_LAYER_ID,
          type: 'fill-extrusion',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'fill-extrusion-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              STRUCTURE_EXTRUSION_SELECTED_COLOR,
              ['boolean', ['get', '__shouldDim'], false],
              '#556476',
              STRUCTURE_EXTRUSION_COLOR,
            ],
            'fill-extrusion-height': wallHeightExpression,
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': isFlatMode ? 0 : 1,
            'fill-extrusion-vertical-gradient': false,
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_STRUCTURE_ROOF_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_ROOF_LAYER_ID,
          type: 'fill-extrusion',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'fill-extrusion-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              STRUCTURE_ROOF_SELECTED_COLOR,
              ['boolean', ['get', '__shouldDim'], false],
              STRUCTURE_ROOF_DIM_COLOR,
              STRUCTURE_ROOF_COLOR,
            ],
            'fill-extrusion-base': wallHeightExpression,
            'fill-extrusion-height': visualStructureHeightExpression,
            'fill-extrusion-opacity': isFlatMode ? 0 : 1,
            'fill-extrusion-vertical-gradient': false,
          },
        });
      }

      // Windows layer - procedural grid pattern on building facades
      if (!nativeMap.getLayer(LOCATION_STRUCTURE_WINDOWS_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_WINDOWS_LAYER_ID,
          type: 'fill-extrusion',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'fill-extrusion-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              '#0d4a62', // Darker blue for selected window
              '#2d5569', // Medium-dark blue for unselected
            ],
            'fill-extrusion-base': ['max', ['+', wallHeightExpression, -2.2], 0.4],
            'fill-extrusion-height': ['max', ['-', wallHeightExpression, 0.2], 0],
            'fill-extrusion-opacity': isFlatMode ? 0 : 0.28, // Subtle window effect
            'fill-extrusion-vertical-gradient': false,
          },
        });
      }

      // Doors layer - ground-level entrance suggestions
      if (!nativeMap.getLayer(LOCATION_STRUCTURE_DOORS_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_DOORS_LAYER_ID,
          type: 'fill-extrusion',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'fill-extrusion-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              '#0a3a4a', // Darker entrance for selected
              '#1a3a4a', // Medium entrance for unselected
            ],
            'fill-extrusion-base': 0,
            'fill-extrusion-height': 2.1, // Door height
            'fill-extrusion-opacity': isFlatMode ? 0 : 0.42,
            'fill-extrusion-vertical-gradient': false,
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_STRUCTURE_OUTLINE_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_STRUCTURE_OUTLINE_LAYER_ID,
          type: 'line',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isStructure'], true], visibleOrSelectedFilter],
          paint: {
            'line-color': buildStructureOutlineColor(viewModeRef.current),
            'line-width': buildStructureOutlineWidth(viewModeRef.current),
            'line-opacity': buildStructureOutlineOpacity(viewModeRef.current),
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_SURFACE_FILL_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_SURFACE_FILL_LAYER_ID,
          type: 'fill',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isSurface'], true], visibleOrSelectedFilter],
          paint: {
            'fill-color': [
              'match',
              ['coalesce', ['get', '__surfaceKind'], 'open'],
              'parking', '#8c939c',
              'pitch', '#74aa6f',
              'field', '#7fba73',
              'garden', '#7ebd76',
              'court', '#9a8b68',
              'track', '#b0624e',
              'plaza', '#b8ae9f',
              'courtyard', '#b8ae9f',
              'square', '#b8ae9f',
              '#c3cdd8',
            ],
            'fill-opacity': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              isFlatMode ? 0.2 : 0.28,
              ['!', ['boolean', ['get', '__isVisible'], false]],
              0,
              ['boolean', ['get', '__shouldDim'], false],
              isFlatMode ? 0.08 : 0.16,
              isFlatMode ? 0.14 : 0.22,
            ],
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_SURFACE_OUTLINE_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_SURFACE_OUTLINE_LAYER_ID,
          type: 'line',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isSurface'], true], visibleOrSelectedFilter],
          paint: {
            'line-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              SURFACE_SELECTED_OUTLINE_COLOR,
              SURFACE_OUTLINE_COLOR,
            ],
            'line-width': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              2.2,
              ['match', ['coalesce', ['get', '__surfaceKind'], 'open'], 'parking', 1.15, 'pitch', 1.05, 0.85],
            ],
            'line-opacity': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              0.76,
              ['!', ['boolean', ['get', '__isVisible'], false]],
              0.46,
              0.0,
            ],
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_FENCE_FILL_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_FENCE_FILL_LAYER_ID,
          type: 'fill',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isFence'], true], visibleOrSelectedFilter],
          paint: {
            'fill-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              FENCE_FILL_SELECTED_COLOR,
              FENCE_FILL_COLOR,
            ],
            'fill-opacity': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              isFlatMode ? 0.18 : 0.06,
              ['!', ['boolean', ['get', '__isVisible'], false]],
              0,
              ['boolean', ['get', '__shouldDim'], false],
              isFlatMode ? 0.08 : 0.03,
              isFlatMode ? 0.12 : 0.04,
            ],
          },
        }, nativeMap.getLayer(LOCATION_STRUCTURE_SHADOW_LAYER_ID) ? LOCATION_STRUCTURE_SHADOW_LAYER_ID : undefined);
      }

      if (!nativeMap.getLayer(LOCATION_FENCE_WALL_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_FENCE_WALL_LAYER_ID,
          type: 'fill-extrusion',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isFence'], true], visibleOrSelectedFilter],
          paint: {
            'fill-extrusion-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              FENCE_WALL_SELECTED_COLOR,
              FENCE_WALL_COLOR,
            ],
            'fill-extrusion-base': 0,
            'fill-extrusion-height': FENCE_WALL_HEIGHT_M,
            'fill-extrusion-opacity': isFlatMode ? 0 : 0.48,
            'fill-extrusion-vertical-gradient': false,
          },
        }, nativeMap.getLayer(LOCATION_STRUCTURE_SHADOW_LAYER_ID) ? LOCATION_STRUCTURE_SHADOW_LAYER_ID : undefined);
      }

      if (!nativeMap.getLayer(LOCATION_FENCE_OUTLINE_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_FENCE_OUTLINE_LAYER_ID,
          type: 'line',
          source: LOCATION_SOURCE_ID,
          filter: ['all', ['==', ['get', '__isFence'], true], visibleOrSelectedFilter],
          paint: {
            'line-color': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              FENCE_OUTLINE_SELECTED_COLOR,
              FENCE_OUTLINE_COLOR,
            ],
            'line-width': [
              'case',
              ['boolean', ['get', '__isSelected'], false],
              isFlatMode ? 2.1 : 1.25,
              isFlatMode ? 1.35 : 0.9,
            ],
            'line-opacity': isFlatMode ? 0.88 : 0.62,
          },
        }, nativeMap.getLayer(LOCATION_STRUCTURE_SHADOW_LAYER_ID) ? LOCATION_STRUCTURE_SHADOW_LAYER_ID : undefined);
      }

      if (!nativeMap.getLayer(LOCATION_HOVER_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_HOVER_LAYER_ID,
          type: 'line',
          source: LOCATION_SOURCE_ID,
          filter: ['==', ['get', '__featureId'], ''],
          paint: {
            'line-color': '#14b8a6',
            'line-width': isFlatMode ? 2.6 : 1.4,
            'line-opacity': isFlatMode ? 0.95 : 0.16,
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_SELECTED_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_SELECTED_LAYER_ID,
          type: 'line',
          source: LOCATION_SOURCE_ID,
          filter: ['==', ['get', '__isSelected'], true],
          paint: {
            'line-color': '#0ea5e9',
            'line-width': isFlatMode ? 3 : 1.5,
            'line-opacity': isFlatMode ? 0.9 : 0.24,
          },
        });
      }

      if (!nativeMap.getLayer(LOCATION_ENTRY_LAYER_ID)) {
        nativeMap.addLayer({
          id: LOCATION_ENTRY_LAYER_ID,
          type: 'circle',
          source: LOCATION_ENTRY_SOURCE_ID,
          paint: {
            'circle-color': '#f8fafc',
            'circle-stroke-color': '#0ea5e9',
            'circle-stroke-width': 2,
            'circle-radius': 5,
            'circle-opacity': 0.98,
          },
        });
      }

      syncLocationLayerPaints(nativeMap, viewModeRef.current);
      syncHoverFilter(nativeMap, hoveredFeatureIdRef.current);
      syncSelectionMarkerPlacement(nativeMap);
    };

    const ensureLayersInitialized = (): void => {
      initializeLayers();

      if (!nativeMap.isStyleLoaded() || hasInitializedLayers()) {
        return;
      }

      window.setTimeout(() => {
        if (!nativeMap.isStyleLoaded() || hasInitializedLayers()) {
          return;
        }

        initializeLayers();
      }, 120);
    };

    const handleMapClick = (event: MapMouseEvent): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      const feature = getInteractiveFeatureAtPoint(nativeMap, event.point);
      const featureId = readCampusFeatureId(feature);
      if (!feature || !featureId) {
        setPreviewFeatureId(null);
        return;
      }

      if (selectedLocationRef.current?.id === featureId) {
        openBottomSheetRef.current();
        return;
      }

      setPreviewFeatureId(featureId);
      selectLocationRef.current({
        id: featureId,
        name: String(feature.properties?.name ?? 'Unknown location'),
        type: String(feature.properties?.type ?? 'Unknown'),
        coordinates: getFeatureFallbackCoordinates(feature),
        properties: { ...(feature.properties ?? {}) },
      });
      openBottomSheetRef.current();
    };

    const handleMapMouseMove = (event: MapMouseEvent): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      const feature = getInteractiveFeatureAtPoint(nativeMap, event.point);
      nativeMap.getCanvas().style.cursor = feature ? 'pointer' : '';
      const nextId = readCampusFeatureId(feature) ?? '';
      if (hoveredFeatureIdRef.current === nextId) {
        return;
      }

      hoveredFeatureIdRef.current = nextId;
      syncHoverFilter(nativeMap, hoveredFeatureIdRef.current);
    };

    const handleCanvasMouseLeave = (): void => {
      hoveredFeatureIdRef.current = '';
      nativeMap.getCanvas().style.cursor = '';
      syncHoverFilter(nativeMap, '');
    };

    const handleMapIdle = (): void => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      if (!hasInitializedLayers()) {
        ensureLayersInitialized();
        return;
      }

      syncLocationLayerPaints(nativeMap, viewModeRef.current);
      syncHoverFilter(nativeMap, hoveredFeatureIdRef.current);
      syncSelectionMarkerPlacement(nativeMap);
    };
    const cleanupLoad = map.on('load', ensureLayersInitialized);
    const cleanupStyle = map.on('styledata', ensureLayersInitialized);
    nativeMap.on('idle', handleMapIdle);
    // Re-sync paints after camera moves/animations finish so 2.5D visuals update reliably
    const cleanupMoveEnd = map.on('moveend', () => {
      const native = map?.nativeMap;
      if (!native || !native.isStyleLoaded()) {
        return;
      }
      // re-sync moveend (no debug logs)

      // If layers were removed by a recent style change, ensure they exist before applying paints.
      const someLayerExists = Boolean(native.getLayer(LOCATION_STRUCTURE_FILL_LAYER_ID));
      if (!someLayerExists) {
        // layers missing, re-initializing layers
        initializeLayers();
        // Small delay to let the map integrate new layers before applying paints
        setTimeout(() => {
          if (!native.isStyleLoaded()) {
            return;
          }
          syncLocationLayerPaints(native, viewModeRef.current);
        }, 30);
        return;
      }

      syncLocationLayerPaints(native, viewModeRef.current);
      syncSelectionMarkerPlacement(native);
    });
    nativeMap.on('click', handleMapClick);
    nativeMap.on('mousemove', handleMapMouseMove);
    ensureLayersInitialized();
    const mountRetryFrame = window.requestAnimationFrame(() => {
      ensureLayersInitialized();
    });
    const mountRetryTimeout = window.setTimeout(() => {
      ensureLayersInitialized();
    }, 220);

    const canvas = nativeMap.getCanvas();
    canvas.addEventListener('mouseleave', handleCanvasMouseLeave);

    return (): void => {
      cleanupLoad();
      cleanupStyle();
      nativeMap.off('idle', handleMapIdle);
      cleanupMoveEnd();
      nativeMap.off('click', handleMapClick);
      nativeMap.off('mousemove', handleMapMouseMove);
      window.cancelAnimationFrame(mountRetryFrame);
      window.clearTimeout(mountRetryTimeout);
      canvas.removeEventListener('mouseleave', handleCanvasMouseLeave);
      hoveredFeatureIdRef.current = '';
      nativeMap.getCanvas().style.cursor = '';
      if (!nativeMap.isStyleLoaded()) {
        return;
      }
      removeLocationLayers(nativeMap);
    };
  }, [map, openBottomSheet, selectLocation, viewMode]);

  useEffect(() => {
    const nativeMap = map?.nativeMap;
    if (!nativeMap || !nativeMap.isStyleLoaded()) {
      return;
    }

    syncLocationLayerPaints(nativeMap, viewMode);
    syncSelectionMarkerPlacement(nativeMap);

    const timeoutId = window.setTimeout(() => {
      if (!nativeMap.isStyleLoaded()) {
        return;
      }

      syncLocationLayerPaints(nativeMap, viewMode);
      syncSelectionMarkerPlacement(nativeMap);
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [map]);

  return null;
};

export default LocationOutlineLayer;
