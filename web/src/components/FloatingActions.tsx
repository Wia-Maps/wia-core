import { motion } from 'framer-motion';
import { useAppStore } from '../store/useAppStore';
import { clientConfig } from '../config/client';
import { flyToUserLocationWithPopup } from '../core/mapLocation';
import type { MapEngineAdapter } from '../core/mapEngineTypes';

interface FloatingActionsProps {
  mapInstance?: MapEngineAdapter | null;
}

/**
 * Compact map controls pinned above the map.
 */
export const FloatingActions: React.FC<FloatingActionsProps> = ({ mapInstance }) => {
  const {
    isOnline,
    userLocation,
    selectedLocation,
    deselectLocation,
    setActiveFilters,
  } = useAppStore();

  const handleLocateUser = (): void => {
    if (mapInstance && userLocation) {
      flyToUserLocationWithPopup(mapInstance, userLocation, 17, 0.7);
    }
  };

  const handleResetView = (): void => {
    deselectLocation();
    setActiveFilters([]);

    mapInstance?.flyTo(clientConfig.map.center, clientConfig.map.zoom, { duration: 0.7 });
  };

  const statusColor = isOnline ? 'bg-emerald-400' : 'bg-rose-400';

  return (
    <div className="pointer-events-none absolute right-3 top-20 z-30 w-[270px] sm:right-4 sm:w-[290px]">
      <motion.div
        className="ui-frost rounded-2xl p-3 shadow-[0_18px_42px_rgba(15,23,42,0.3)]"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24 }}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="status-pill border border-slate-200 bg-white text-slate-700">
            <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
            {isOnline ? 'Live map' : 'Offline mode'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleLocateUser}
            disabled={!userLocation}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Locate
          </button>

          <button
            type="button"
            onClick={handleResetView}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Reset
          </button>
        </div>

        {selectedLocation && (
          <button
            type="button"
            onClick={deselectLocation}
            className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Clear selection
          </button>
        )}
      </motion.div>
    </div>
  );
};

export default FloatingActions;
