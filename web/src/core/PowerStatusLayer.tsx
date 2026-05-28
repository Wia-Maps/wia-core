import { useEffect, useRef } from 'react';
import { useToast } from '../context/ToastContext';
import { useAppStore } from '../store/useAppStore';
import type { PowerSignal } from '../store/useAppStore';
import {
  fetchLocationPowerSignal,
  fetchRecentPowerSignals,
  subscribeToPowerSignals,
  type PowerSignalRecord,
} from '../services/powerStatus';
import { clientConfig } from '../config/client';

interface PowerStatusLayerProps {
  selectedLocationId?: string | null;
}

const toStoreSignal = (record: PowerSignalRecord): PowerSignal => ({
  locationId: record.locationId,
  powerStatus: record.powerStatus,
  reportedAt: new Date(record.reportedAt).getTime(),
  reportedBy: record.reportedBy ?? null,
});

export const PowerStatusLayer: React.FC<PowerStatusLayerProps> = ({ selectedLocationId = null }) => {
  const reconnectTimerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const { getPowerSignal, updatePowerSignals } = useAppStore();
  const { showWarning } = useToast();

  useEffect(() => {
    if (!clientConfig.features.powerStatus) {
      return;
    }

    let cancelled = false;

    const loadInitialSignals = async (): Promise<void> => {
      try {
        const reports = await fetchRecentPowerSignals(500);

        if (!cancelled && reports.length > 0) {
          updatePowerSignals(reports.map(toStoreSignal));
        }
      } catch (error) {
        console.warn('Unable to fetch initial power signals:', error);
        showWarning('Unable to load live power status right now.', {
          title: 'Power updates',
          dedupeKey: 'power-initial-load',
        });
      }
    };

    void loadInitialSignals();

    return () => {
      cancelled = true;
    };
  }, [showWarning, updatePowerSignals]);

  useEffect(() => {
    if (!clientConfig.features.powerStatus) {
      return;
    }

    let disposed = false;

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const connect = (): void => {
      socketRef.current = subscribeToPowerSignals({
        onReport: (report) => {
          updatePowerSignals([toStoreSignal(report)]);
        },
        onClose: () => {
          if (disposed) {
            return;
          }

          clearReconnectTimer();
          reconnectTimerRef.current = window.setTimeout(connect, 2000);
        },
        onError: () => {
          socketRef.current?.close();
        },
      });
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [updatePowerSignals]);

  useEffect(() => {
    if (!clientConfig.features.powerStatus || !selectedLocationId || getPowerSignal(selectedLocationId)) {
      return;
    }

    let cancelled = false;

    const loadSelectedLocationSignal = async (): Promise<void> => {
      try {
        const report = await fetchLocationPowerSignal(selectedLocationId);

        if (!cancelled && report) {
          updatePowerSignals([toStoreSignal(report)]);
        }
      } catch (error) {
        console.warn(`Unable to fetch power signal for ${selectedLocationId}:`, error);
        showWarning('Unable to fetch the latest power status for this location.', {
          title: 'Power updates',
          dedupeKey: `power-location-load-${selectedLocationId}`,
        });
      }
    };

    void loadSelectedLocationSignal();

    return () => {
      cancelled = true;
    };
  }, [getPowerSignal, selectedLocationId, showWarning, updatePowerSignals]);

  return null;
};

export default PowerStatusLayer;
