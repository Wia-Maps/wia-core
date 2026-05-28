import { useEffect, useRef } from 'react';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import maplibregl from 'maplibre-gl';
import {
  formatFellowshipSchedule,
  normalizeFellowshipCode,
  readFellowshipEntries,
} from './fellowshipUtils';
import { resolveFeatureAnchorCoordinates } from './geoGeometry';
import { useAppStore } from '../store/useAppStore';
import type { MapEngineAdapter } from './mapEngineTypes';
import { matchesLocationFilters } from './locationFilters';

interface FeatureProperties {
  id?: string;
  name?: string;
  type?: string;
  fellowships?: unknown;
  [key: string]: unknown;
}

type CampusFeature = Feature<Geometry, FeatureProperties>;
type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;

interface FellowshipSelection {
  id: string;
  name: string;
  type: string;
  coordinates: [number, number];
  properties?: Record<string, unknown>;
  fellowshipFocusCode?: string | null;
  fellowshipServiceFocusKey?: string | null;
}

interface FellowshipLayerProps {
  map: MapEngineAdapter | null;
  geojsonData?: CampusCollection | null;
  enabled: boolean;
  showAll: boolean;
  onSelectFellowship: (selection: FellowshipSelection) => void;
}

const resolveFeatureId = (feature: CampusFeature, index: number): string => {
  return String(feature.id ?? feature.properties?.id ?? `feature_${index}`);
};

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const buildAnchorStemHtml = (): string => {
  return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;margin-top:4px;"><span style="display:block;height:10px;width:2px;border-radius:999px;background:linear-gradient(180deg,rgba(148,163,184,0.08),rgba(71,85,105,0.36));"></span><span style="display:flex;height:14px;width:14px;align-items:center;justify-content:center;border-radius:999px;background:#ffffff;border:1px solid rgba(148,163,184,0.32);box-shadow:0 8px 18px rgba(15,23,42,0.16);"><span style="display:block;height:6px;width:6px;border-radius:999px;background:#0ea5e9;"></span></span></div>';
};

const buildBadgeIcon = (code: string, logoUrl?: string | null, active = false): HTMLDivElement => {
  const element = document.createElement('div');
  const escapedCode = escapeHtml(code);
  const escapedLogoUrl = escapeHtml(logoUrl ?? '');
  const anchorStemHtml = buildAnchorStemHtml();
  const frameBorder = active ? 'rgba(14,165,233,0.5)' : 'rgba(148,163,184,0.22)';
  const frameShadow = active
    ? '0 20px 38px rgba(14,165,233,0.26)'
    : '0 16px 30px rgba(15,23,42,0.14)';
  const frameBackground = active
    ? 'linear-gradient(180deg,rgba(239,248,255,0.98),rgba(248,250,252,0.95))'
    : 'linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.94))';

  element.className = 'wia-fellowship-badge-icon';

  if (logoUrl) {
    element.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;width:78px;height:82px;"><div data-fellowship-badge-face="true" style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:78px;height:50px;border-radius:22px;border:1px solid ${frameBorder};background:${frameBackground};padding:6px 8px;box-shadow:${frameShadow};"><div style="height:26px;width:100%;border-radius:14px;background-color:rgba(255,255,255,0.92);background-image:url('${escapedLogoUrl}');background-repeat:no-repeat;background-position:center center;background-size:contain;"></div><span style="margin-top:4px;font:700 9px/1 Outfit, Manrope, sans-serif;letter-spacing:0.18em;text-transform:uppercase;color:#475569;">${escapedCode}</span></div><div data-fellowship-popup-trigger="true">${anchorStemHtml}</div></div>`;
    return element;
  }

  element.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;min-width:72px;height:68px;"><div data-fellowship-badge-face="true" style="display:flex;min-width:56px;height:40px;align-items:center;justify-content:center;border-radius:18px;border:1px solid ${frameBorder};background:${frameBackground};padding:0 12px;font:700 11px/1.1 Outfit, Manrope, sans-serif;letter-spacing:0.16em;text-transform:uppercase;color:#0f172a;box-shadow:${frameShadow};">${escapedCode}</div><div data-fellowship-popup-trigger="true">${anchorStemHtml}</div></div>`;
  return element;
};

const buildTooltipHtml = (
  name: string,
  services: ReturnType<typeof readFellowshipEntries>[number]['services'],
  contact?: string | undefined
): string => {
  const preview = services
    .slice(0, 2)
    .map((service) => {
      const parts = [formatFellowshipSchedule(service), service.roomLabel ?? '', service.infoLabel ?? '']
        .filter(Boolean)
        .map((value) => escapeHtml(value));

      return `<div style="margin-top:6px;font-size:11px;color:#475569;">${parts.join(' • ')}</div>`;
    })
    .join('');
  const extraCount = Math.max(0, services.length - 2);

  const contactHtml = contact ? `<div style="margin-top:4px;font-size:11px;color:#475569;">${escapeHtml(contact)}</div>` : '';

  return `<div style="min-width:180px;font-family:Manrope,sans-serif;"><div style="font-size:12px;font-weight:700;color:#0f172a;">${escapeHtml(name)}</div>${contactHtml}${preview}${extraCount > 0 ? `<div style="margin-top:6px;font-size:11px;color:#64748b;">+${extraCount} more service${extraCount === 1 ? '' : 's'}</div>` : ''}</div>`;
};

export const FellowshipLayer = ({
  map,
  geojsonData,
  enabled,
  showAll,
  onSelectFellowship,
}: FellowshipLayerProps) => {
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const popupsRef = useRef<maplibregl.Popup[]>([]);
  const { activeFilters, fellowshipBrandsByCode, selectedLocation } = useAppStore();

  useEffect(() => {
    const activeMap = map?.nativeMap;
    if (!activeMap) {
      return;
    }
    let renderFrame: number | null = null;

    const clearMarkers = (): void => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      popupsRef.current.forEach((popup) => popup.remove());
      popupsRef.current = [];
    };

    const scheduleRender = (): void => {
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame);
      }

      renderFrame = requestAnimationFrame(() => {
        renderFrame = null;
        render();
      });
    };

    if (!enabled || !geojsonData?.features) {
      clearMarkers();
      return;
    }

    const render = (): void => {
      clearMarkers();

      geojsonData.features.forEach((feature, index) => {
        const properties = feature.properties ?? {};
        const category = String(properties.type ?? 'Location');
        const featureId = resolveFeatureId(feature, index);

        if (!matchesLocationFilters(category, activeFilters)) {
          return;
        }

        const fellowships = readFellowshipEntries(properties.fellowships);
        if (fellowships.length === 0) {
          return;
        }

        const coordinates = resolveFeatureAnchorCoordinates(feature);
        const centerPoint = map.project(coordinates);
        const locationName = String(properties.name ?? 'Unknown location');
        const selectedLocationId = selectedLocation?.id ?? null;
        const selectedFellowshipCode = normalizeFellowshipCode(selectedLocation?.fellowshipFocusCode);
        const visibleFellowships = showAll
          ? fellowships
          : fellowships.filter((entry) => {
              return (
                selectedLocationId === featureId &&
                selectedFellowshipCode === normalizeFellowshipCode(entry.code)
              );
            });

        if (visibleFellowships.length === 0) {
          return;
        }

        const offsetUnit = visibleFellowships.length > 2 ? 42 : 48;

        visibleFellowships.forEach((entry, fellowshipIndex) => {
          const fellowshipBrand = fellowshipBrandsByCode[normalizeFellowshipCode(entry.code)] ?? null;
          const entryActive =
            selectedLocationId === featureId &&
            selectedFellowshipCode === normalizeFellowshipCode(entry.code);
          const xOffset = (fellowshipIndex - (visibleFellowships.length - 1) / 2) * offsetUnit;
          const shiftedLatLng = map.unproject({ x: centerPoint.x + xOffset, y: centerPoint.y });
          const popup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: [0, -12],
            className: 'fellowship-popup',
          }).setHTML(buildTooltipHtml(fellowshipBrand?.name ?? entry.name, entry.services, fellowshipBrand?.contact ?? entry.contact));
          
          const markerElement = buildBadgeIcon(entry.code, fellowshipBrand?.logoUrl ?? null, entryActive);
          const marker = new maplibregl.Marker({
            element: markerElement,
            anchor: 'bottom',
          })
            .setLngLat([shiftedLatLng[1], shiftedLatLng[0]])
            .setPopup(popup)
            .addTo(activeMap);

          const popupTriggerElement =
            markerElement.querySelector<HTMLElement>('[data-fellowship-popup-trigger="true"]') ?? markerElement;

          popupTriggerElement.addEventListener('mouseenter', () => {
            popup.setLngLat([shiftedLatLng[1], shiftedLatLng[0]]).addTo(activeMap);
          });
          markerElement.addEventListener('mouseleave', () => {
            popup.remove();
          });
          markerElement.addEventListener('click', () => {
            onSelectFellowship({
              id: featureId,
              name: locationName,
              type: category,
              coordinates,
              properties: { ...(properties as Record<string, unknown>) },
              fellowshipFocusCode: entry.code,
              fellowshipServiceFocusKey: null,
            });
          });

          markersRef.current.push(marker);
          popupsRef.current.push(popup);
        });
      });
    };

    scheduleRender();
    const cleanupLoad = map.on('load', scheduleRender);
    const cleanupStyle = map.on('styledata', scheduleRender);
    const cleanupMove = map.on('moveend', scheduleRender);
    activeMap.on('move', scheduleRender);
    activeMap.on('zoom', scheduleRender);
    activeMap.on('rotate', scheduleRender);
    activeMap.on('pitch', scheduleRender);

    return (): void => {
      cleanupLoad();
      cleanupStyle();
      cleanupMove();
      activeMap.off('move', scheduleRender);
      activeMap.off('zoom', scheduleRender);
      activeMap.off('rotate', scheduleRender);
      activeMap.off('pitch', scheduleRender);
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame);
      }
      clearMarkers();
    };
  }, [activeFilters, enabled, fellowshipBrandsByCode, geojsonData, map, onSelectFellowship, selectedLocation, showAll]);

  return null;
};

export default FellowshipLayer;
