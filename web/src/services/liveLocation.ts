import { useAppStore } from '../store/useAppStore';
import { resolveSocketUrl } from '../config/api';

let socket: WebSocket | null = null;
let watchId: number | null = null;
let wakeLock: any | null = null;
let autoStopTimer: any | null = null;
let heartbeatTimer: any | null = null;
let reconnectTimer: any | null = null;
const BROADCAST_LIMIT_MS = 60 * 60 * 1000; // 1 Hour
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
const RECONNECT_DELAY_MS = 3000; // 3 seconds
const SOS_STORAGE_KEY = 'wia_active_sos_session';
const VIEWER_STORAGE_KEY = 'wia_active_live_viewer_token';

type BroadcastSessionState = {
  sessionId: string;
  broadcasterToken: string;
};

type ViewerSessionState = {
  liveToken: string;
  viewerToken: string;
};

let activeBroadcastSession: BroadcastSessionState | null = null;
let activeViewerSession: ViewerSessionState | null = null;

const readStoredJson = <T>(storageKey: string): T | null => {
  const rawValue = localStorage.getItem(storageKey);
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch {
    return null;
  }
};

const clearViewerSessionState = (): void => {
  activeViewerSession = null;
  localStorage.removeItem(VIEWER_STORAGE_KEY);
};

const clearBroadcastSessionState = (): void => {
  activeBroadcastSession = null;
  localStorage.removeItem(SOS_STORAGE_KEY);
};

const resolveNextConnectionState = (): 'connecting' | 'offline' => (
  typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting'
);

const startHeartbeat = () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
};

export const startBroadcasting = (sessionId: string, broadcasterToken: string) => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) stopBroadcasting();
  activeBroadcastSession = { sessionId, broadcasterToken };
  useAppStore.getState().setLiveConnectionState(resolveNextConnectionState());

  const connect = () => {
    useAppStore.getState().setLiveConnectionState(resolveNextConnectionState());
    socket = new WebSocket(resolveSocketUrl('/ws/live-location'));

    socket.onopen = async () => {
      if (socket) {
        socket.send(JSON.stringify({ type: 'join', role: 'broadcaster', token: broadcasterToken }));
        startHeartbeat();
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'joined') {
          const initialLocation = useAppStore.getState().userLocation;
          useAppStore.getState().setLiveConnectionState('connected');
          useAppStore.getState().setLiveTrackingStatus(message.sessionId || sessionId, true);
          useAppStore.getState().setLiveViewerCount(typeof message.viewerCount === 'number' ? message.viewerCount : 0);
          localStorage.setItem(SOS_STORAGE_KEY, JSON.stringify({ sessionId, broadcasterToken }));

          if (initialLocation && socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'location_update',
              lat: initialLocation[0],
              lng: initialLocation[1],
            }));
          }
        } else if (message.type === 'viewer_count_update') {
          useAppStore.getState().setLiveViewerCount(message.count);
        } else if (message.type === 'session_ended') {
          stopBroadcasting();
        } else if (message.type === 'join_rejected') {
          useAppStore.getState().setLiveTrackingStatus(null, false);
          useAppStore.getState().setLiveConnectionState('rejected');
          clearBroadcastSessionState();
          if (socket) {
            socket.close();
            socket = null;
          }
        }
      } catch (err) {
        console.error('Broadcaster message error:', err);
      }
    };

    socket.onclose = () => {
      if (activeBroadcastSession) {
        useAppStore.getState().setLiveConnectionState(resolveNextConnectionState());
        console.warn('Broadcaster socket closed unexpectedly, reconnecting...');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  };

  connect();
  
  // Device features (Wake Lock, Geolocation, Timer) - only set once
  if (!watchId) {
    if ('wakeLock' in navigator) {
      (navigator as any).wakeLock.request('screen').then((lock: any) => { wakeLock = lock; }).catch(console.warn);
    }

    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'location_update',
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              accuracy: position.coords.accuracy
            }));
          }
          useAppStore.getState().setLiveGpsAccuracy(position.coords.accuracy);
          useAppStore.getState().updateSharedIntentCoordinates([
            position.coords.latitude,
            position.coords.longitude
          ]);
        },
        (error) => console.error('WatchPosition Error:', error),
        { enableHighAccuracy: true, maximumAge: 0 }
      );
    }

    autoStopTimer = setTimeout(() => {
      stopBroadcasting();
    }, BROADCAST_LIMIT_MS);
  }
};

export const stopBroadcasting = () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (autoStopTimer) clearTimeout(autoStopTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  
  autoStopTimer = null;
  heartbeatTimer = null;

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (wakeLock) {
    wakeLock.release().then(() => { wakeLock = null; });
  }
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'end_session' }));
    }
    socket.close();
    socket = null;
  }
  clearBroadcastSessionState();
  useAppStore.getState().setLiveTrackingStatus(null, false);
  useAppStore.getState().setLiveConnectionState('idle');
  useAppStore.getState().setLiveViewerCount(0);
  useAppStore.getState().setLiveGpsAccuracy(null);
};

export const joinAsViewer = (viewerToken: string, liveToken: string, onEvent?: (type: string) => void) => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) leaveSession();
  activeViewerSession = { liveToken, viewerToken };
  useAppStore.getState().setLiveConnectionState(resolveNextConnectionState());

  const connect = () => {
    useAppStore.getState().setLiveConnectionState(resolveNextConnectionState());
    socket = new WebSocket(resolveSocketUrl('/ws/live-location'));

    socket.onopen = () => {
      if (socket) {
        socket.send(JSON.stringify({ type: 'join', role: 'viewer', token: viewerToken }));
        startHeartbeat();
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'joined') {
          useAppStore.getState().setLiveConnectionState('connected');
          useAppStore.getState().setLiveTrackingStatus(message.sessionId, false);
          if (Array.isArray(message.coordinates) && message.coordinates.length === 2) {
            useAppStore.getState().updateSharedIntentCoordinates([message.coordinates[0], message.coordinates[1]]);
          }
          localStorage.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ liveToken }));
        } else if (message.type === 'location_update') {
          useAppStore.getState().updateSharedIntentCoordinates([message.data.lat, message.data.lng]);
        } else if (message.type === 'location_history') {
          // Logic for breadcrumbs can be added here
          console.log('Received location history for breadcrumbs:', message.data.length);
        } else if (message.type === 'session_ended') {
          clearViewerSessionState();
          onEvent?.('session_ended');
          leaveSession();
        } else if (message.type === 'broadcaster_offline') {
          onEvent?.('broadcaster_offline');
        } else if (message.type === 'join_rejected') {
          clearViewerSessionState();
          useAppStore.getState().setLiveTrackingStatus(null, false);
          useAppStore.getState().setLiveConnectionState('rejected');
          if (socket) {
            socket.close();
            socket = null;
          }
        }
      } catch (err) {
        console.error('Viewer message error:', err);
      }
    };

    socket.onclose = () => {
      if (activeViewerSession) {
        useAppStore.getState().setLiveConnectionState(resolveNextConnectionState());
        console.warn('Viewer socket closed unexpectedly, reconnecting...');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  };

  connect();
};

export const leaveSession = () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (socket) {
    socket.close();
    socket = null;
  }
  clearViewerSessionState();
  useAppStore.getState().setLiveTrackingStatus(null, false);
  useAppStore.getState().setLiveConnectionState('idle');
};

export const getStoredSOSSession = (): BroadcastSessionState | null => {
  const legacySessionId = localStorage.getItem(SOS_STORAGE_KEY);
  if (!legacySessionId) {
    return null;
  }

  const parsedSession = readStoredJson<BroadcastSessionState>(SOS_STORAGE_KEY);
  if (parsedSession?.sessionId && parsedSession?.broadcasterToken) {
    return parsedSession;
  }

  return null;
};

export const getStoredViewerLiveToken = (): string | null => {
  const parsedSession = readStoredJson<{ liveToken?: string }>(VIEWER_STORAGE_KEY);
  return parsedSession?.liveToken ?? null;
};
