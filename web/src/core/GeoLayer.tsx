import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useAppStore } from '../store/useAppStore';
import { clientConfig } from '../config/client';

interface GeoLayerProps {
  map: L.Map | null;
  geojsonUrl: string;
  onFeatureLoaded?: (count: number) => void;
}

/**
 * GeoLayer Component
 * 
 * Loads and renders GeoJSON features as interactive polygons/layers
 * - Fetches GeoJSON from URL
 * - Creates clickable polygons
 * - Handles feature selection and popups
 */
export const GeoLayer: React.FC<GeoLayerProps> = ({
  map,
  geojsonUrl,
  onFeatureLoaded,
}) => {
  const geojsonLayerRef = useRef<L.GeoJSON | null>(null);
  const { selectLocation } = useAppStore();

  useEffect(() => {
    if (!map || geojsonLayerRef.current) return;

    const loadGeoJSON = async () => {
      try {
        const response = await fetch(geojsonUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch GeoJSON: ${response.status}`);
        }
        const geojsonData = await response.json();

        // Wait for map to be fully ready before adding layers
        map.whenReady(() => {
          if (!geojsonLayerRef.current) {
            // Create GeoJSON layer
            const geoJsonLayer = L.geoJSON(geojsonData, {
          style: () => ({
            color: clientConfig.theme.primary,
            weight: 2,
            opacity: 0.8,
            fillOpacity: 0.3,
          }),
          onEachFeature: (feature, layer) => {
            // Handle polygon click
            layer.on('click', () => {
              const props = feature.properties || {};
              const id = feature.id || props.id || `feature_${Date.now()}`;
              const name = props.name || 'Unknown Location';
              const type = props.type || 'Feature';

              // Get center coordinates
              let coordinates: [number, number] = clientConfig.map.center;
              if (
                feature.geometry.type === 'Polygon' &&
                feature.geometry.coordinates.length > 0
              ) {
                const coords = feature.geometry.coordinates[0];
                if (coords.length > 0) {
                  const [lng, lat] = coords[0];
                  coordinates = [lat, lng];
                }
              }

              selectLocation({
                id: String(id),
                name,
                type,
                coordinates,
                properties: props,
              });
            });

            // Hover effects
            layer.on('mouseover', () => {
              (layer as L.Path).setStyle({
                weight: 3,
                opacity: 1,
                fillOpacity: 0.5,
              });
              if ('bringToFront' in layer) {
                (layer as any).bringToFront();
              }
            });

            layer.on('mouseout', () => {
              (layer as L.Path).setStyle({
                weight: 2,
                opacity: 0.8,
                fillOpacity: 0.3,
              });
              (layer as any).bringToBack?.();
            });
          },
            }).addTo(map);

            geojsonLayerRef.current = geoJsonLayer;
            onFeatureLoaded?.(geojsonData.features?.length || 0);
          }
        });
      } catch (error) {
        console.error('Error loading GeoJSON:', error);
      }
    };

    loadGeoJSON();

    return () => {
      if (geojsonLayerRef.current && map) {
        map.removeLayer(geojsonLayerRef.current);
        geojsonLayerRef.current = null;
      }
    };
  }, [map, geojsonUrl, selectLocation]);

  return null; // This is a data layer, no UI rendering needed
};

export default GeoLayer;
