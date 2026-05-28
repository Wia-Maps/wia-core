import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, Geometry } from 'geojson';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { clientConfig } from '../../config/client';

type EditableFeature = Feature<Geometry, Record<string, unknown>>;
type EditablePathGeometryType = 'LineString' | 'Polygon';

interface AdminFeatureGeometryEditorProps {
  feature: EditableFeature | null;
  onFeatureChange: (feature: EditableFeature) => void;
  referenceFeatures?: EditableFeature[];
  activeFeatureId?: string | null;
}

const toLatLng = (coordinates: [number, number]): [number, number] => [coordinates[1], coordinates[0]];

const isLngLat = (coordinate: unknown): coordinate is [number, number] => {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return false;
  }

  const [lng, lat] = coordinate;
  return Number.isFinite(Number(lng)) && Number.isFinite(Number(lat));
};

const toLngLat = (latLng: L.LatLng): [number, number] => [latLng.lng, latLng.lat];

const pointCoordinates = (feature: EditableFeature | null): [number, number] | null => {
  if (!feature || feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) {
    return null;
  }

  const [lng, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return [Number(lng), Number(lat)];
};

const lineCoordinates = (feature: EditableFeature | null): [number, number][] => {
  if (!feature || feature.geometry.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) {
    return [];
  }

  return feature.geometry.coordinates
    .map((coordinate) => (isLngLat(coordinate) ? [Number(coordinate[0]), Number(coordinate[1])] as [number, number] : null))
    .filter((coordinate): coordinate is [number, number] => Boolean(coordinate));
};

const polygonCoordinates = (feature: EditableFeature | null): [number, number][] => {
  if (!feature || feature.geometry.type !== 'Polygon' || !Array.isArray(feature.geometry.coordinates)) {
    return [];
  }

  const outerRing = Array.isArray(feature.geometry.coordinates[0]) ? feature.geometry.coordinates[0] : [];

  return outerRing
    .map((coordinate) => (isLngLat(coordinate) ? [Number(coordinate[0]), Number(coordinate[1])] as [number, number] : null))
    .filter((coordinate): coordinate is [number, number] => Boolean(coordinate));
};

const updateFeatureGeometry = (
  feature: EditableFeature,
  geometry: Geometry
): EditableFeature => ({
  ...feature,
  geometry,
});

const polygonWithoutClosingPoint = (coordinates: [number, number][]): [number, number][] => {
  if (coordinates.length < 2) {
    return coordinates;
  }

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];

  if (first[0] === last[0] && first[1] === last[1]) {
    return coordinates.slice(0, -1);
  }

  return coordinates;
};

const closedPolygonCoordinates = (coordinates: [number, number][]): [number, number][] => {
  const openCoordinates = polygonWithoutClosingPoint(coordinates);
  if (openCoordinates.length < 3) {
    return openCoordinates;
  }

  return [...openCoordinates, openCoordinates[0]];
};

const featurePathCoordinates = (feature: EditableFeature, geometryType: EditablePathGeometryType): [number, number][] => {
  return geometryType === 'LineString' ? lineCoordinates(feature) : polygonWithoutClosingPoint(polygonCoordinates(feature));
};

const updatePathGeometry = (
  feature: EditableFeature,
  geometryType: EditablePathGeometryType,
  coordinates: [number, number][]
): EditableFeature => {
  if (geometryType === 'LineString') {
    return updateFeatureGeometry(feature, {
      type: 'LineString',
      coordinates,
    });
  }

  return updateFeatureGeometry(feature, {
    type: 'Polygon',
    coordinates: [closedPolygonCoordinates(coordinates)],
  });
};

const midpoint = (left: [number, number], right: [number, number]): [number, number] => [
  (left[0] + right[0]) / 2,
  (left[1] + right[1]) / 2,
];

const vertexIcon = (selected: boolean): L.DivIcon =>
  L.divIcon({
    className: '',
    iconSize: selected ? [22, 22] : [18, 18],
    iconAnchor: selected ? [11, 11] : [9, 9],
    html: `<span style="display:block;width:${selected ? 22 : 18}px;height:${selected ? 22 : 18}px;border-radius:9999px;border:${selected ? 4 : 3}px solid ${selected ? '#0f172a' : '#ffffff'};background:${selected ? '#f97316' : '#0891b2'};box-shadow:0 2px 10px rgba(15,23,42,0.28);"></span>`,
  });

const midpointIcon = (): L.DivIcon =>
  L.divIcon({
    className: '',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    html: '<span style="display:block;width:14px;height:14px;border-radius:9999px;border:2px solid #ffffff;background:#38bdf8;box-shadow:0 2px 8px rgba(15,23,42,0.22);opacity:0.92;"></span>',
  });

const pointCount = (feature: EditableFeature | null): number => {
  if (!feature) {
    return 0;
  }

  if (feature.geometry.type === 'Point') {
    return pointCoordinates(feature) ? 1 : 0;
  }

  if (feature.geometry.type === 'LineString') {
    return lineCoordinates(feature).length;
  }

  if (feature.geometry.type === 'Polygon') {
    return polygonWithoutClosingPoint(polygonCoordinates(feature)).length;
  }

  return 0;
};

const toFeatureId = (feature: EditableFeature | null): string => {
  if (typeof feature?.id === 'string') {
    return feature.id.trim();
  }

  if (typeof feature?.id === 'number' && Number.isFinite(feature.id)) {
    return String(feature.id);
  }

  return '';
};

const featureIdentityKey = (feature: EditableFeature | null): string | null => {
  if (!feature) {
    return null;
  }

  if (typeof feature.id === 'string' && feature.id.trim()) {
    return `id:${feature.id.trim()}`;
  }

  if (typeof feature.id === 'number' && Number.isFinite(feature.id)) {
    return `id:${String(feature.id)}`;
  }

  const properties = feature.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const propertyId = (properties as Record<string, unknown>).id;
    if (typeof propertyId === 'string' && propertyId.trim()) {
      return `prop:${propertyId.trim()}`;
    }
    if (typeof propertyId === 'number' && Number.isFinite(propertyId)) {
      return `prop:${String(propertyId)}`;
    }
  }

  return `geometry:${feature.geometry.type}`;
};

const frameMapToFeature = (map: L.Map, feature: EditableFeature | null): void => {
  if (!feature) {
    map.setView(clientConfig.map.center, 16);
    return;
  }

  if (feature.geometry.type === 'Point') {
    const coordinates = pointCoordinates(feature);
    if (!coordinates) {
      return;
    }
    map.setView(toLatLng(coordinates), 17);
    return;
  }

  if (feature.geometry.type === 'LineString') {
    const coordinates = lineCoordinates(feature);
    if (coordinates.length === 0) {
      return;
    }
    if (coordinates.length === 1) {
      map.setView(toLatLng(coordinates[0]), 17);
      return;
    }
    map.fitBounds(L.latLngBounds(coordinates.map(toLatLng)), { padding: [24, 24] });
    return;
  }

  if (feature.geometry.type === 'Polygon') {
    const coordinates = polygonCoordinates(feature);
    if (coordinates.length === 0) {
      return;
    }
    if (coordinates.length === 1) {
      map.setView(toLatLng(coordinates[0]), 17);
      return;
    }
    map.fitBounds(L.latLngBounds(coordinates.map(toLatLng)), { padding: [24, 24] });
  }
};

const drawReferenceFeature = (layerGroup: L.LayerGroup, feature: EditableFeature): void => {
  if (feature.geometry.type === 'Point') {
    const coordinates = pointCoordinates(feature);
    if (!coordinates) {
      return;
    }

    L.circleMarker(toLatLng(coordinates), {
      radius: 4,
      color: '#64748b',
      fillColor: '#cbd5e1',
      fillOpacity: 0.78,
      weight: 1.5,
    }).addTo(layerGroup);
    return;
  }

  if (feature.geometry.type === 'LineString') {
    const coordinates = lineCoordinates(feature);
    if (coordinates.length < 2) {
      return;
    }

    L.polyline(coordinates.map(toLatLng), {
      color: '#94a3b8',
      weight: 3,
      opacity: 0.65,
    }).addTo(layerGroup);
    return;
  }

  if (feature.geometry.type === 'Polygon') {
    const coordinates = polygonCoordinates(feature);
    if (coordinates.length < 3) {
      return;
    }

    L.polygon(coordinates.map(toLatLng), {
      color: '#94a3b8',
      weight: 2,
      fillColor: '#e2e8f0',
      fillOpacity: 0.2,
    }).addTo(layerGroup);
  }
};

export const AdminFeatureGeometryEditor: React.FC<AdminFeatureGeometryEditorProps> = ({
  feature,
  onFeatureChange,
  referenceFeatures = [],
  activeFeatureId = null,
}) => {
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const featureRef = useRef<EditableFeature | null>(feature);
  const onFeatureChangeRef = useRef(onFeatureChange);
  const framedFeatureKeyRef = useRef<string | null>(null);

  useEffect(() => {
    featureRef.current = feature;
    onFeatureChangeRef.current = onFeatureChange;
  }, [feature, onFeatureChange]);

  const activePointCount = useMemo(() => pointCount(feature), [feature]);
  const selectedCoordinate = useMemo(() => {
    if (!feature || selectedVertexIndex === null) {
      return null;
    }

    if (feature.geometry.type === 'LineString') {
      return lineCoordinates(feature)[selectedVertexIndex] ?? null;
    }

    if (feature.geometry.type === 'Polygon') {
      return polygonWithoutClosingPoint(polygonCoordinates(feature))[selectedVertexIndex] ?? null;
    }

    return null;
  }, [feature, selectedVertexIndex]);
  const canRemoveSelectedVertex = useMemo(() => {
    if (!feature || selectedVertexIndex === null) {
      return false;
    }

    if (feature.geometry.type === 'LineString') {
      return lineCoordinates(feature).length > 2;
    }

    if (feature.geometry.type === 'Polygon') {
      return polygonWithoutClosingPoint(polygonCoordinates(feature)).length > 3;
    }

    return false;
  }, [feature, selectedVertexIndex]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView(clientConfig.map.center, 16);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
    }).addTo(map);

    const layerGroup = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = layerGroup;

    const handleClick = (event: L.LeafletMouseEvent): void => {
      const activeFeature = featureRef.current;

      if (!activeFeature) {
        return;
      }

      const nextCoordinate: [number, number] = [event.latlng.lng, event.latlng.lat];

      if (activeFeature.geometry.type === 'Point') {
        onFeatureChangeRef.current(
          updateFeatureGeometry(activeFeature, {
            type: 'Point',
            coordinates: nextCoordinate,
          })
        );
        return;
      }

      if (activeFeature.geometry.type === 'LineString') {
        const nextCoordinates = [...lineCoordinates(activeFeature), nextCoordinate];
        onFeatureChangeRef.current(updatePathGeometry(activeFeature, 'LineString', nextCoordinates));
        setSelectedVertexIndex(nextCoordinates.length - 1);
        return;
      }

      if (activeFeature.geometry.type === 'Polygon') {
        const nextCoordinates = [...polygonWithoutClosingPoint(polygonCoordinates(activeFeature)), nextCoordinate];
        onFeatureChangeRef.current(updatePathGeometry(activeFeature, 'Polygon', nextCoordinates));
        setSelectedVertexIndex(nextCoordinates.length - 1);
      }
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
      layerGroup.clearLayers();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;

    if (!map || !layerGroup) {
      return;
    }

    layerGroup.clearLayers();
    markerRef.current = null;

    if (!feature) {
      framedFeatureKeyRef.current = null;
      return;
    }

    const drawEditablePath = (geometryType: EditablePathGeometryType): void => {
      const coordinates = featurePathCoordinates(feature, geometryType);

      if (coordinates.length === 0) {
        return;
      }

      if (selectedVertexIndex !== null && selectedVertexIndex >= coordinates.length) {
        setSelectedVertexIndex(null);
      }

      if (geometryType === 'LineString' && coordinates.length >= 2) {
        L.polyline(coordinates.map(toLatLng), {
          color: '#0891b2',
          weight: 4,
        }).addTo(layerGroup);
      }

      if (geometryType === 'Polygon' && coordinates.length >= 3) {
        L.polygon(coordinates.map(toLatLng), {
          color: '#16a34a',
          weight: 3,
          fillColor: '#4ade80',
          fillOpacity: 0.24,
        }).addTo(layerGroup);
      }

      coordinates.forEach((coordinate, index) => {
        const marker = L.marker(toLatLng(coordinate), {
          draggable: true,
          icon: vertexIcon(selectedVertexIndex === index),
          keyboard: false,
          zIndexOffset: selectedVertexIndex === index ? 1600 : 1500,
        }).addTo(layerGroup);

        marker.on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          setSelectedVertexIndex(index);
        });

        marker.on('dragstart', () => {
          setSelectedVertexIndex(index);
        });

        marker.on('dragend', () => {
          const activeFeature = featureRef.current;
          if (!activeFeature || activeFeature.geometry.type !== geometryType) {
            return;
          }

          const nextCoordinates = featurePathCoordinates(activeFeature, geometryType);
          nextCoordinates[index] = toLngLat(marker.getLatLng());
          onFeatureChangeRef.current(updatePathGeometry(activeFeature, geometryType, nextCoordinates));
          setSelectedVertexIndex(index);
        });
      });

      const insertHandleCount = geometryType === 'Polygon' && coordinates.length >= 3
        ? coordinates.length
        : Math.max(0, coordinates.length - 1);

      for (let index = 0; index < insertHandleCount; index += 1) {
        const nextIndex = index === coordinates.length - 1 ? 0 : index + 1;
        const insertCoordinate = midpoint(coordinates[index], coordinates[nextIndex]);
        const marker = L.marker(toLatLng(insertCoordinate), {
          draggable: true,
          icon: midpointIcon(),
          keyboard: false,
          zIndexOffset: 1400,
        }).addTo(layerGroup);

        const insertPoint = (coordinate: [number, number]): void => {
          const activeFeature = featureRef.current;
          if (!activeFeature || activeFeature.geometry.type !== geometryType) {
            return;
          }

          const nextCoordinates = featurePathCoordinates(activeFeature, geometryType);
          const insertIndex = index + 1;
          nextCoordinates.splice(insertIndex, 0, coordinate);
          onFeatureChangeRef.current(updatePathGeometry(activeFeature, geometryType, nextCoordinates));
          setSelectedVertexIndex(insertIndex);
        };

        marker.on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          insertPoint(insertCoordinate);
        });

        marker.on('dragend', () => {
          insertPoint(toLngLat(marker.getLatLng()));
        });
      }
    };

    referenceFeatures
      .filter((entry) => featureIdentityKey(entry) !== activeFeatureId && toFeatureId(entry) !== activeFeatureId)
      .forEach((entry) => {
        drawReferenceFeature(layerGroup, entry);
      });

    if (feature.geometry.type === 'Point') {
      const coordinates = pointCoordinates(feature);

      if (!coordinates) {
        map.setView(clientConfig.map.center, 16);
        return;
      }

      const marker = L.marker(toLatLng(coordinates), { draggable: true }).addTo(layerGroup);
      marker.on('dragend', () => {
        const nextLatLng = marker.getLatLng();
        onFeatureChange(
          updateFeatureGeometry(feature, {
            type: 'Point',
            coordinates: [nextLatLng.lng, nextLatLng.lat],
          })
        );
      });
      markerRef.current = marker;
    } else if (feature.geometry.type === 'LineString') {
      drawEditablePath('LineString');
    } else if (feature.geometry.type === 'Polygon') {
      drawEditablePath('Polygon');
    }

    const nextFeatureKey = featureIdentityKey(feature);
    if (nextFeatureKey && framedFeatureKeyRef.current !== nextFeatureKey) {
      frameMapToFeature(map, feature);
      framedFeatureKeyRef.current = nextFeatureKey;
    }
  }, [activeFeatureId, feature, onFeatureChange, referenceFeatures, selectedVertexIndex]);

  const handleRefitMap = (): void => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    frameMapToFeature(map, feature);
    framedFeatureKeyRef.current = featureIdentityKey(feature);
  };

  const handleUndo = (): void => {
    if (!feature) {
      return;
    }

    if (feature.geometry.type === 'Point') {
      onFeatureChange(
        updateFeatureGeometry(feature, {
          type: 'Point',
          coordinates: [clientConfig.map.center[1], clientConfig.map.center[0]],
        })
      );
      return;
    }

    if (feature.geometry.type === 'LineString') {
      const nextCoordinates = lineCoordinates(feature).slice(0, -1);
      onFeatureChange(updatePathGeometry(feature, 'LineString', nextCoordinates));
      setSelectedVertexIndex(null);
      return;
    }

    if (feature.geometry.type === 'Polygon') {
      const nextCoordinates = polygonWithoutClosingPoint(polygonCoordinates(feature)).slice(0, -1);
      onFeatureChange(updatePathGeometry(feature, 'Polygon', nextCoordinates));
      setSelectedVertexIndex(null);
    }
  };

  const handleClosePolygon = (): void => {
    if (!feature || feature.geometry.type !== 'Polygon') {
      return;
    }

    const coordinates = polygonWithoutClosingPoint(polygonCoordinates(feature));
    if (coordinates.length < 3) {
      return;
    }

    onFeatureChange(
      updatePathGeometry(feature, 'Polygon', coordinates)
    );
  };

  const handleRemoveSelectedVertex = (): void => {
    if (!feature || selectedVertexIndex === null || !canRemoveSelectedVertex) {
      return;
    }

    if (feature.geometry.type === 'LineString') {
      const nextCoordinates = lineCoordinates(feature);
      nextCoordinates.splice(selectedVertexIndex, 1);
      onFeatureChange(updatePathGeometry(feature, 'LineString', nextCoordinates));
      setSelectedVertexIndex(null);
      return;
    }

    if (feature.geometry.type === 'Polygon') {
      const nextCoordinates = polygonWithoutClosingPoint(polygonCoordinates(feature));
      nextCoordinates.splice(selectedVertexIndex, 1);
      onFeatureChange(updatePathGeometry(feature, 'Polygon', nextCoordinates));
      setSelectedVertexIndex(null);
    }
  };

  const handleClear = (): void => {
    if (!feature) {
      return;
    }

    if (feature.geometry.type === 'Point') {
      onFeatureChange(
        updateFeatureGeometry(feature, {
          type: 'Point',
          coordinates: [clientConfig.map.center[1], clientConfig.map.center[0]],
        })
      );
      return;
    }

    if (feature.geometry.type === 'LineString') {
      onFeatureChange(
        updateFeatureGeometry(feature, {
          type: 'LineString',
          coordinates: [],
        })
      );
      setSelectedVertexIndex(null);
      return;
    }

    onFeatureChange(
      updateFeatureGeometry(feature, {
        type: 'Polygon',
        coordinates: [[]],
      })
    );
    setSelectedVertexIndex(null);
  };

  const showPolygonActions = feature?.geometry.type === 'Polygon';
  const selectedVertexLabel = selectedCoordinate
    ? `Point ${selectedVertexIndex === null ? '' : selectedVertexIndex + 1}`
    : null;

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700">Geometry</p>
          <p className="mt-1 text-sm font-medium text-slate-600">Click the map to add points. Drag solid handles to reshape, or use the smaller handles between points to insert detail.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {feature ? (
            <>
              <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                {feature.geometry.type}
              </span>
              <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-800">
                {activePointCount} {activePointCount === 1 ? 'point' : 'points'}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-4 h-[360px] overflow-hidden rounded-[24px] border border-slate-200 md:h-[480px]">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleUndo}
          disabled={!feature}
          className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-700"
        >
          Undo
        </button>
        {showPolygonActions ? (
          <button
            type="button"
            onClick={handleClosePolygon}
            disabled={activePointCount < 3}
            className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close polygon
          </button>
        ) : null}
        {selectedVertexLabel ? (
          <button
            type="button"
            onClick={handleRemoveSelectedVertex}
            disabled={!canRemoveSelectedVertex}
            className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Remove {selectedVertexLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleClear}
          disabled={!feature}
          className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-700"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleRefitMap}
          disabled={!feature}
          className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-700"
        >
          Refit map
        </button>
      </div>
      {selectedVertexLabel && !canRemoveSelectedVertex ? (
        <p className="mt-3 text-xs font-medium text-slate-500">
          {feature?.geometry.type === 'Polygon'
            ? 'Keep at least 3 polygon points.'
            : 'Keep at least 2 line points.'}
        </p>
      ) : null}
    </div>
  );
};

export default AdminFeatureGeometryEditor;
