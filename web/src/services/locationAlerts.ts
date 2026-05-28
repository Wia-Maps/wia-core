import axios from 'axios';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
  type Messaging,
  type Unsubscribe,
} from 'firebase/messaging';
import { resolveApiBaseUrl } from '../config/api';

type SyncResultStatus =
  | 'updated'
  | 'subscribed'
  | 'removed'
  | 'unsupported'
  | 'blocked'
  | 'unavailable'
  | 'skipped';

export interface LocationAlertSyncResult {
  status: SyncResultStatus;
  message?: string;
}

export interface LocationAlertMessage {
  eventId?: string | null;
  title: string;
  body: string;
  module: string;
  locationId: string | null;
  locationName?: string | null;
  createdAt?: number | null;
}

export interface LocationAlertEvent {
  id: string;
  locationId: string;
  locationName: string;
  module: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: string;
  createdAt: number;
}

interface NotificationConfigResponse {
  enabled: boolean;
}

interface NotificationEventResponse {
  id: string;
  locationId: string;
  locationName: string;
  module: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: string;
  createdAt: string;
}

const notificationApiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  withCredentials: true,
});

const getFirebaseMessagingConfig = () => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;

  return {
    apiKey: env?.VITE_FIREBASE_API_KEY?.trim() || '',
    authDomain: env?.VITE_FIREBASE_AUTH_DOMAIN?.trim() || '',
    projectId: env?.VITE_FIREBASE_PROJECT_ID?.trim() || '',
    storageBucket: env?.VITE_FIREBASE_STORAGE_BUCKET?.trim() || '',
    messagingSenderId: env?.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
    appId: env?.VITE_FIREBASE_APP_ID?.trim() || '',
    vapidKey: env?.VITE_FIREBASE_VAPID_KEY?.trim() || '',
  };
};

const isPushSupported = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator
  );
};

const ensureFirebaseMessaging = async (): Promise<Messaging | null> => {
  if (!isPushSupported() || !(await isSupported())) {
    return null;
  }

  const firebaseConfig = getFirebaseMessagingConfig();

  if (
    !firebaseConfig.apiKey ||
    !firebaseConfig.projectId ||
    !firebaseConfig.messagingSenderId ||
    !firebaseConfig.appId ||
    !firebaseConfig.vapidKey
  ) {
    return null;
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return getMessaging(app);
};

const getNotificationConfig = async (): Promise<NotificationConfigResponse> => {
  const response = await notificationApiClient.get<{ success: boolean; data: NotificationConfigResponse }>(
    '/notifications/config'
  );

  return response.data.data;
};

const getServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration> => {
  const existingRegistration = await navigator.serviceWorker.getRegistration('/');

  if (existingRegistration?.active) {
    return existingRegistration;
  }

  if (!existingRegistration) {
    await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
  } else {
    void existingRegistration.update().catch(() => undefined);
  }

  return navigator.serviceWorker.ready;
};

const getFcmToken = async (messaging: Messaging): Promise<string | null> => {
  const { vapidKey } = getFirebaseMessagingConfig();

  if (!vapidKey) {
    return null;
  }

  const serviceWorkerRegistration = await getServiceWorkerRegistration();

  return getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration,
  });
};

const syncServerToken = async (token: string, favouriteLocationIds: string[]): Promise<void> => {
  await notificationApiClient.put('/notifications/subscription', {
    token,
    favouriteLocationIds,
    userAgent: navigator.userAgent,
  });
};

export const requestFavouriteAlertOptIn = async (
  favouriteLocationIds: string[]
): Promise<LocationAlertSyncResult> => {
  if (!isPushSupported()) {
    return {
      status: 'unsupported',
      message: 'Push notifications are not supported in this browser or context.',
    };
  }

  if (favouriteLocationIds.length === 0) {
    return { status: 'skipped' };
  }

  if (Notification.permission === 'denied') {
    return {
      status: 'blocked',
      message: 'Browser notifications are blocked for this site.',
    };
  }

  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();

  if (permission !== 'granted') {
    return {
      status: 'blocked',
      message: 'Notifications were not enabled for this browser.',
    };
  }

  const config = await getNotificationConfig();
  if (!config.enabled) {
    return {
      status: 'unavailable',
      message: 'Favourite alerts are not configured on this server yet.',
    };
  }

  const messaging = await ensureFirebaseMessaging();
  if (!messaging) {
    return {
      status: 'unsupported',
      message: 'Firebase messaging is not available in this browser.',
    };
  }

  const token = await getFcmToken(messaging);
  if (!token) {
    return {
      status: 'unavailable',
      message: 'Unable to create a notification token for this device.',
    };
  }

  await syncServerToken(token, favouriteLocationIds);

  return {
    status: 'subscribed',
  };
};

export const syncFavouriteAlertSubscription = async (
  favouriteLocationIds: string[]
): Promise<LocationAlertSyncResult> => {
  if (!isPushSupported() || Notification.permission !== 'granted') {
    return { status: 'skipped' };
  }

  const config = await getNotificationConfig();
  if (!config.enabled) {
    return { status: 'skipped' };
  }

  const messaging = await ensureFirebaseMessaging();
  if (!messaging) {
    return { status: 'skipped' };
  }

  const token = await getFcmToken(messaging);
  if (!token) {
    return { status: 'skipped' };
  }

  if (favouriteLocationIds.length === 0) {
    await notificationApiClient.delete('/notifications/subscription', {
      data: { token },
    });

    return { status: 'removed' };
  }

  await syncServerToken(token, favouriteLocationIds);
  return { status: 'updated' };
};

export const subscribeToForegroundLocationAlerts = async (
  onAlert: (message: LocationAlertMessage) => void
): Promise<Unsubscribe | null> => {
  const messaging = await ensureFirebaseMessaging();

  if (!messaging) {
    return null;
  }

  return onMessage(messaging, (payload: MessagePayload) => {
    const title =
      payload.data?.title || payload.notification?.title || 'Wia update';
    const body =
      payload.data?.body ||
      payload.notification?.body ||
      'A campus location you follow has a new update.';
    const parsedCreatedAt = payload.data?.createdAt ? Date.parse(payload.data.createdAt) : Date.now();

    onAlert({
      eventId: payload.data?.eventId ?? null,
      title,
      body,
      module: payload.data?.module || 'location',
      locationId: payload.data?.locationId ?? null,
      locationName: payload.data?.locationName ?? null,
      createdAt: Number.isNaN(parsedCreatedAt) ? Date.now() : parsedCreatedAt,
    });
  });
};

export const fetchLocationAlertEvents = async (
  favouriteLocationIds: string[],
  limit = 20
): Promise<LocationAlertEvent[]> => {
  if (favouriteLocationIds.length === 0) {
    return [];
  }

  const response = await notificationApiClient.get<{
    success: boolean;
    data: NotificationEventResponse[];
  }>('/notifications/events', {
    params: {
      locationIds: favouriteLocationIds.join(','),
      limit,
    },
  });

  return response.data.data.map((event) => ({
    id: event.id,
    locationId: event.locationId,
    locationName: event.locationName,
    module: event.module,
    title: event.title,
    body: event.body,
    data: event.data ?? {},
    status: event.status,
    createdAt: Number.isNaN(Date.parse(event.createdAt)) ? Date.now() : Date.parse(event.createdAt),
  }));
};
