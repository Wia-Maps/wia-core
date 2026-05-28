import { useEffect, useRef } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import maplibregl from 'maplibre-gl';
import { useAppStore } from '../store/useAppStore';
import type { MapEngineAdapter } from './mapEngineTypes';
import { resolveFeatureAnchorCoordinates, resolveFeatureId, resolveFeatureVisualClass } from './geoGeometry';
import { hasPowerSupply } from './locationFilters';

interface FeatureProperties {
  id?: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;

interface PowerSupplySelection {
  id: string;
  name: string;
  type: string;
  coordinates: [number, number];
  properties?: Record<string, unknown>;
}

interface PowerSupplyOverlayLayerProps {
  map: MapEngineAdapter | null;
  geojsonData?: CampusCollection | null;
  enabled: boolean;
  onSelectLocation: (selection: PowerSupplySelection) => void;
}

const buildBulbMarker = (locationName: string): HTMLDivElement => {
  const element = document.createElement('div');
  element.className = 'wia-power-bulb-marker';
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', `Open ${locationName}`);
  element.title = locationName;
  element.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;height:58px;width:44px;">
      <div style="display:grid;height:34px;width:34px;place-items:center;border-radius:999px;border:1px solid rgba(245,158,11,0.5);background:linear-gradient(180deg,rgba(255,251,235,0.98),rgba(254,243,199,0.96));box-shadow:0 14px 28px rgba(180,83,9,0.24),0 0 0 5px rgba(251,191,36,0.14);color:#b45309;">
        <svg viewBox="0 0 24 24" style="height:20px;width:20px;" aria-hidden="true">
          <path d="M9.2 18.2h5.6M10 21h4M8.4 14.8c-1.2-1-2-2.6-2-4.3a5.6 5.6 0 1 1 11.2 0c0 1.7-.8 3.3-2 4.3-.7.6-1.1 1.1-1.2 2H9.6c-.1-.9-.5-1.4-1.2-2Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9"></path>
        </svg>
      </div>
      <span style="display:block;height:10px;width:2px;border-radius:999px;background:linear-gradient(180deg,rgba(245,158,11,0.28),rgba(71,85,105,0.28));"></span>
      <span style="display:block;height:9px;width:9px;border-radius:999px;border:1px solid rgba(245,158,11,0.32);background:#ffffff;box-shadow:0 6px 14px rgba(15,23,42,0.12);"></span>
    </div>
  `;
  return element;
};

export const PowerSupplyOverlayLayer: React.FC<PowerSupplyOverlayLayerProps> = ({
  map,
  geojsonData,
  enabled,
  onSelectLocation,
}) => {
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const powerSignalMap = useAppStore((state) => state.powerSignalMap);

  useEffect(() => {
    const activeMap = map?.nativeMap;
    if (!activeMap) {
      return;
    }

    const clearMarkers = (): void => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
    };

    if (!enabled || !geojsonData?.features) {
      clearMarkers();
      return clearMarkers;
    }

    geojsonData.features.forEach((feature, index) => {
      const geometryType = feature.geometry?.type;
      if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
        return;
      }

      if (resolveFeatureVisualClass(feature) !== 'structure') {
        return;
      }

      const locationId = resolveFeatureId(feature, index) ?? `feature_${index}`;
      if (!hasPowerSupply(locationId, powerSignalMap)) {
        return;
      }

      const properties = feature.properties ?? {};
      const locationName = String(properties.name ?? 'Unknown location');
      const locationType = String(properties.type ?? 'Location');
      const coordinates = resolveFeatureAnchorCoordinates(feature);
      const markerElement = buildBulbMarker(locationName);
      const marker = new maplibregl.Marker({
        element: markerElement,
        anchor: 'bottom',
      })
        .setLngLat([coordinates[1], coordinates[0]])
        .addTo(activeMap);

      markerElement.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectLocation({
          id: locationId,
          name: locationName,
          type: locationType,
          coordinates,
          properties: { ...(properties as Record<string, unknown>) },
        });
      });

      markersRef.current.push(marker);
    });

    return clearMarkers;
  }, [enabled, geojsonData, map, onSelectLocation, powerSignalMap]);

  return null;
};

export default PowerSupplyOverlayLayer;
