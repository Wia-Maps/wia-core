import { useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import { subscribeToForegroundLocationAlerts } from '../services/locationAlerts';
import { useAppStore } from '../store/useAppStore';

export const FavouriteNotificationMessageLayer: React.FC = () => {
  const { showSuccess } = useToast();
  const upsertNotificationEvents = useAppStore((state) => state.upsertNotificationEvents);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    const connect = async (): Promise<void> => {
      unsubscribe = await subscribeToForegroundLocationAlerts((message) => {
        if (cancelled) {
          return;
        }

        if (message.locationId) {
          upsertNotificationEvents([
            {
              id:
                message.eventId ??
                `${message.module}-${message.locationId}-${message.createdAt ?? Date.now()}`,
              locationId: message.locationId,
              locationName: message.locationName ?? message.title,
              module: message.module,
              title: message.title,
              body: message.body,
              status: 'completed',
              createdAt: message.createdAt ?? Date.now(),
              data: {},
            },
          ]);
        }

        showSuccess(message.body, {
          title: message.title,
          dedupeKey: `foreground-alert-${message.module}-${message.locationId ?? 'unknown'}-${message.body}`,
          durationMs: 5200,
        });
      });
    };

    void connect();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [showSuccess, upsertNotificationEvents]);

  return null;
};

export default FavouriteNotificationMessageLayer;
