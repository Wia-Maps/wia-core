import type { LngLatLike, Map as MapLibreMap } from 'maplibre-gl';
import type { ScreenPoint } from './mapMetrics';

export type MapViewMode = 'flat' | '2_5d';

export interface MapAnimationOptions {
  animate?: boolean;
  duration?: number;
}

export interface MapBoundsPadding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface MapEngineAdapter {
  readonly nativeMap: MapLibreMap;
  flyTo(center: [number, number], zoom?: number, options?: MapAnimationOptions): void;
  panTo(center: [number, number], options?: MapAnimationOptions): void;
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: { padding?: number | MapBoundsPadding; duration?: number }
  ): void;
  getCenter(): [number, number];
  getZoom(): number;
  distance(from: [number, number], to: [number, number]): number;
  project(location: [number, number]): ScreenPoint;
  unproject(point: ScreenPoint): [number, number];
  setViewMode(mode: MapViewMode): void;
  getViewMode(): MapViewMode;
  openUserLocationPopup(): void;
  flyToUserLocationWithPopup(
    location: [number, number],
    zoom?: number,
    duration?: number
  ): void;
  once(event: 'moveend' | 'load' | 'styledata', handler: () => void): void;
  on(event: 'moveend' | 'load' | 'styledata', handler: () => void): () => void;
  isStyleLoaded(): boolean;
}

export const toMapLibreLngLat = (location: [number, number]): LngLatLike => [location[1], location[0]];
