import { useEffect, useMemo, useRef } from 'react';
import { useToast } from '../context/ToastContext';
import { useAppStore } from '../store/useAppStore';
import { syncFavouriteAlertSubscription } from '../services/locationAlerts';

const RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];

export const FavouriteNotificationSyncLayer: React.FC = () => {
  const favouriteLocations = useAppStore((state) => state.favouriteLocations);
  const isOnline = useAppStore((state) => state.isOnline);
  const { showWarning } = useToast();
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);

  const favouriteLocationIds = useMemo(() => {
    return favouriteLocations.map((location) => location.id);
  }, [favouriteLocations]);

  const syncSignature = useMemo(() => {
    return [...favouriteLocationIds].sort().join('|');
  }, [favouriteLocationIds]);

  useEffect(() => {
    let cancelled = false;

    const clearRetryTimer = (): void => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const scheduleRetry = (): void => {
      if (cancelled || !isOnline) {
        return;
      }

      const delayMs = RETRY_DELAYS_MS[Math.min(retryAttemptRef.current, RETRY_DELAYS_MS.length - 1)];
      retryAttemptRef.current += 1;
      clearRetryTimer();

      retryTimerRef.current = window.setTimeout(() => {
        void syncFavouriteAlerts();
      }, delayMs);
    };

    const syncFavouriteAlerts = async (): Promise<void> => {
      if (cancelled || !isOnline) {
        return;
      }

      try {
        await syncFavouriteAlertSubscription(favouriteLocationIds);
        retryAttemptRef.current = 0;
        clearRetryTimer();
      } catch (error) {
        if (cancelled) {
          return;
        }

        showWarning('Favourite alerts could not be synced right now.', {
          title: 'Favourite alerts',
          dedupeKey: 'favourite-alert-sync',
          durationMs: 4800,
        });

        console.warn('Favourite alert sync failed:', error);
        scheduleRetry();
      }
    };

    const handleOnline = (): void => {
      if (cancelled) {
        return;
      }

      retryAttemptRef.current = 0;
      clearRetryTimer();
      void syncFavouriteAlerts();
    };

    window.addEventListener('online', handleOnline);

    retryAttemptRef.current = 0;
    clearRetryTimer();
    void syncFavouriteAlerts();

    return () => {
      cancelled = true;
      clearRetryTimer();
      window.removeEventListener('online', handleOnline);
    };
  }, [favouriteLocationIds, isOnline, showWarning, syncSignature]);

  return null;
};

export default FavouriteNotificationSyncLayer;
