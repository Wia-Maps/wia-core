import type { MapEngineAdapter } from './mapEngineTypes';

export const openUserLocationPopup = (map: MapEngineAdapter): void => {
  map.openUserLocationPopup();
};

export const flyToUserLocationWithPopup = (
  map: MapEngineAdapter,
  location: [number, number],
  zoom = 17,
  duration = 0.6
): void => {
  map.flyToUserLocationWithPopup(location, zoom, duration);
};
