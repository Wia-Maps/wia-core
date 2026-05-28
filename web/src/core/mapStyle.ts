import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { StyleSpecification } from 'maplibre-gl';
import { clientConfig } from '../config/client';
import {
  isBlockingStructureFeature,
  isBoundaryFeature,
  resolveFeatureSurfaceKind,
  resolveFeatureVisualClass,
  type FeatureVisualClass,
} from './geoGeometry';

type CampusFeature = Feature<Geometry, Record<string, unknown>>;
type CampusCollection = FeatureCollection<Geometry, Record<string, unknown>>;

const EXTRUSION_MIN_HEIGHT_M = 3.2;
const SURFACE_SLAB_HEIGHT_M = clientConfig.map.surfaceSlabHeightM ?? 0.18;

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const resolveLowRiseBoost = (floorCount: number): number => {
  const maxFloors = Math.max(1, clientConfig.map.lowRiseBoostMaxFloors ?? 4);
  const maxMultiplier = Math.max(1, clientConfig.map.lowRiseBoostMaxMultiplier ?? 1.18);

  if (floorCount >= maxFloors) {
    return 1;
  }

  const progress = 1 - (floorCount - 1) / Math.max(1, maxFloors - 1);
  return 1 + (maxMultiplier - 1) * clamp(progress, 0, 1);
};

const getStructureHeightMeters = (
  feature: CampusFeature,
  fallbackHeightM = clientConfig.map.structureFallbackHeightM ?? 3.5
): number => {
  const heightValue = feature.properties?.height_m;
  if (typeof heightValue === 'number' && Number.isFinite(heightValue) && heightValue > 0) {
    return Math.max(EXTRUSION_MIN_HEIGHT_M, heightValue);
  }

  const floorCount = feature.properties?.floor_count;
  if (typeof floorCount === 'number' && Number.isFinite(floorCount) && floorCount > 0) {
    const baseHeight = floorCount * clientConfig.map.metersPerFloor;
    return Math.max(EXTRUSION_MIN_HEIGHT_M, baseHeight * resolveLowRiseBoost(Math.round(floorCount)));
  }

  return Math.max(EXTRUSION_MIN_HEIGHT_M, fallbackHeightM);
};

const getFeatureVisualClass = (feature: CampusFeature): FeatureVisualClass => {
  if (isBoundaryFeature(feature)) {
    return 'fence';
  }

  if (isBlockingStructureFeature(feature)) {
    return 'structure';
  }

  return resolveFeatureVisualClass(feature);
};

const buildFeatureProperties = (feature: CampusFeature): Record<string, unknown> => {
  const featureClass = getFeatureVisualClass(feature);
  const surfaceKind = featureClass === 'surface' ? resolveFeatureSurfaceKind(feature) : null;

  return {
    ...(feature.properties ?? {}),
    __featureClass: featureClass,
    __surfaceKind: surfaceKind,
    __isStructure: featureClass === 'structure',
    __isSurface: featureClass === 'surface',
    __isFence: featureClass === 'fence',
    __height_m:
      featureClass === 'structure'
        ? getStructureHeightMeters(feature)
        : 0,
    __surfaceHeight_m: featureClass === 'surface' ? SURFACE_SLAB_HEIGHT_M : 0,
  };
};

export const buildMapStyle = (): StyleSpecification => ({
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'wia-raster-base': {
      type: 'raster',
      tiles: [...clientConfig.map.rasterTileUrls],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    },
  },
  layers: [
    {
      id: 'wia-raster-base',
      type: 'raster',
      source: 'wia-raster-base',
      paint: {
        'raster-saturation': 0.08,
        'raster-contrast': 0.18,
        'raster-brightness-min': 0.06,
        'raster-brightness-max': 0.96,
      },
    },
  ],
});

export const enrichCollectionWithExtrusionHeight = (
  collection: CampusCollection
): CampusCollection => ({
  ...collection,
  features: collection.features.map((feature) => ({
    ...feature,
    properties: buildFeatureProperties(feature),
  })),
});
