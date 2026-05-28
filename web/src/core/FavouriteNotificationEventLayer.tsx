import { useEffect, useMemo, useRef } from 'react';
import { useToast } from '../context/ToastContext';
import { fetchLocationAlertEvents } from '../services/locationAlerts';
import { useAppStore } from '../store/useAppStore';

const RETRY_DELAYS_MS = [4_000, 12_000, 30_000, 60_000];
const REFRESH_INTERVAL_MS = 60_000;

export const FavouriteNotificationEventLayer: React.FC = () => {
  const favouriteLocations = useAppStore((state) => state.favouriteLocations);
  const isOnline = useAppStore((state) => state.isOnline);
  const upsertNotificationEvents = useAppStore((state) => state.upsertNotificationEvents);
  const { showWarning } = useToast();
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const favouriteLocationIds = useMemo(() => {
    return favouriteLocations.map((location) => location.id);
  }, [favouriteLocations]);

  const feedSignature = useMemo(() => {
    return [...favouriteLocationIds].sort().join('|');
  }, [favouriteLocationIds]);

  useEffect(() => {
    let cancelled = false;

    const clearTimers = (): void => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    const scheduleRefresh = (): void => {
      clearTimers();

      refreshTimerRef.current = window.setTimeout(() => {
        void loadNotificationEvents();
      }, REFRESH_INTERVAL_MS);
    };

    const scheduleRetry = (): void => {
      if (cancelled || !isOnline || favouriteLocationIds.length === 0) {
        return;
      }

      const delayMs = RETRY_DELAYS_MS[Math.min(retryAttemptRef.current, RETRY_DELAYS_MS.length - 1)];
      retryAttemptRef.current += 1;

      clearTimers();
      retryTimerRef.current = window.setTimeout(() => {
        void loadNotificationEvents();
      }, delayMs);
    };

    const loadNotificationEvents = async (): Promise<void> => {
      if (cancelled || !isOnline || favouriteLocationIds.length === 0) {
        return;
      }

      try {
        const events = await fetchLocationAlertEvents(favouriteLocationIds, 24);
        upsertNotificationEvents(events);
        retryAttemptRef.current = 0;
        scheduleRefresh();
      } catch (error) {
        if (cancelled) {
          return;
        }

        showWarning('Recent alerts could not be refreshed right now.', {
          title: 'Alerts feed',
          dedupeKey: 'alerts-feed-sync',
          durationMs: 4800,
        });

        console.warn('Alert event refresh failed:', error);
        scheduleRetry();
      }
    };

    const handleOnline = (): void => {
      if (cancelled || favouriteLocationIds.length === 0) {
        return;
      }

      retryAttemptRef.current = 0;
      clearTimers();
      void loadNotificationEvents();
    };

    const handleVisibilityChange = (): void => {
      if (
        cancelled ||
        document.visibilityState !== 'visible' ||
        favouriteLocationIds.length === 0
      ) {
        return;
      }

      retryAttemptRef.current = 0;
      clearTimers();
      void loadNotificationEvents();
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    retryAttemptRef.current = 0;
    clearTimers();

    if (favouriteLocationIds.length > 0) {
      void loadNotificationEvents();
    }

    return () => {
      cancelled = true;
      clearTimers();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [favouriteLocationIds, feedSignature, isOnline, showWarning, upsertNotificationEvents]);

  return null;
};

export default FavouriteNotificationEventLayer;
