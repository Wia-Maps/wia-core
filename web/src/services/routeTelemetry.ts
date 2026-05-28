import { toApiUrl } from '../config/api';

export interface RouteTelemetryPoint {
  latitude: number;
  longitude: number;
  accuracyM: number;
  headingDeg: number | null;
  speedMps: number | null;
  timestampMs: number;
}

export interface RouteTelemetryBatch {
  deviceId: string;
  sessionId: string;
  campusId: string;
  points: RouteTelemetryPoint[];
}

const TELEMETRY_DEVICE_ID_KEY = 'wia_route_telemetry_device_id';
const TELEMETRY_QUEUE_KEY = 'wia_route_telemetry_queue';
const TELEMETRY_SESSION_KEY = 'wia_route_telemetry_session_id';
const TELEMETRY_BATCH_MAX_POINTS = 8;
const TELEMETRY_FLUSH_INTERVAL_MS = 12000;

const resolveLocationTrackingEndpoint = (): string => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const override = env?.VITE_LOCATION_TRACKING_ENDPOINT?.trim();
  return override && override.length > 0 ? override : toApiUrl('/telemetry/routes');
};

const TELEMETRY_ENDPOINT = resolveLocationTrackingEndpoint();

let activeCampusId: string | null = null;
let activeSessionId: string | null = null;
let activePoints: RouteTelemetryPoint[] = [];
let flushTimerId: number | null = null;
let onlineListenerInstalled = false;
let flushing = false;

const randomId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `wia_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const readQueuedBatches = (): RouteTelemetryBatch[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(TELEMETRY_QUEUE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as unknown;
    return Array.isArray(parsed) ? (parsed as RouteTelemetryBatch[]) : [];
  } catch {
    return [];
  }
};

const writeQueuedBatches = (queue: RouteTelemetryBatch[]): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(TELEMETRY_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore persistence failures.
  }
};

export const getOrCreateRouteTelemetryDeviceId = (): string => {
  if (typeof window === 'undefined') {
    return randomId();
  }

  const existing = window.localStorage.getItem(TELEMETRY_DEVICE_ID_KEY)?.trim();
  if (existing) {
    return existing;
  }

  const nextDeviceId = randomId();
  try {
    window.localStorage.setItem(TELEMETRY_DEVICE_ID_KEY, nextDeviceId);
  } catch {
    // Ignore persistence failures.
  }

  return nextDeviceId;
};

const setActiveSessionId = (sessionId: string | null): void => {
  activeSessionId = sessionId;

  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (sessionId) {
      window.localStorage.setItem(TELEMETRY_SESSION_KEY, sessionId);
    } else {
      window.localStorage.removeItem(TELEMETRY_SESSION_KEY);
    }
  } catch {
    // Ignore persistence failures.
  }
};

const startFlushTimer = (): void => {
  if (flushTimerId !== null || typeof window === 'undefined') {
    return;
  }

  flushTimerId = window.setInterval(() => {
    void flushRouteTelemetryQueue();
  }, TELEMETRY_FLUSH_INTERVAL_MS);
};

const stopFlushTimer = (): void => {
  if (flushTimerId === null || typeof window === 'undefined') {
    return;
  }

  window.clearInterval(flushTimerId);
  flushTimerId = null;
};

const enqueueBatch = (batch: RouteTelemetryBatch): void => {
  const queue = readQueuedBatches();
  queue.push(batch);
  writeQueuedBatches(queue);
};

const flushActivePoints = (force = false): void => {
  if (!activeCampusId || !activeSessionId || activePoints.length === 0) {
    return;
  }

  if (!force && activePoints.length < TELEMETRY_BATCH_MAX_POINTS) {
    return;
  }

  enqueueBatch({
    deviceId: getOrCreateRouteTelemetryDeviceId(),
    sessionId: activeSessionId,
    campusId: activeCampusId,
    points: activePoints,
  });
  activePoints = [];
};

const sendBatch = async (batch: RouteTelemetryBatch): Promise<boolean> => {
  const body = JSON.stringify(batch);

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon(
        TELEMETRY_ENDPOINT,
        new Blob([body], { type: 'application/json' })
      );

      if (sent) {
        return true;
      }
    }

    const response = await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
      keepalive: true,
    });

    return response.ok;
  } catch {
    return false;
  }
};

export const installRouteTelemetryOnlineHandler = (): void => {
  if (onlineListenerInstalled || typeof window === 'undefined') {
    return;
  }

  onlineListenerInstalled = true;
  window.addEventListener('online', () => {
    void flushRouteTelemetryQueue();
  });
};

export const ensureRouteTelemetrySession = (campusId: string): string => {
  if (!activeSessionId || activeCampusId !== campusId) {
    activeCampusId = campusId;
    setActiveSessionId(randomId());
    activePoints = [];
  }

  startFlushTimer();
  installRouteTelemetryOnlineHandler();
  return activeSessionId as string;
};

export const recordRouteTelemetryPoint = async (
  campusId: string,
  point: RouteTelemetryPoint
): Promise<void> => {
  ensureRouteTelemetrySession(campusId);
  activePoints.push(point);

  if (activePoints.length >= TELEMETRY_BATCH_MAX_POINTS) {
    flushActivePoints(true);
    await flushRouteTelemetryQueue();
  }
};

export const flushRouteTelemetryQueue = async (): Promise<void> => {
  if (flushing || typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false) {
    return;
  }

  flushing = true;

  try {
    flushActivePoints(true);
    const queue = [...readQueuedBatches()];
    const remaining: RouteTelemetryBatch[] = [];

    for (const batch of queue) {
      // Keep unsent batches in order for replay.
      if (!(await sendBatch(batch))) {
        remaining.push(batch);
      }
    }

    writeQueuedBatches(remaining);
  } finally {
    flushing = false;
  }
};

export const endRouteTelemetrySession = async (): Promise<void> => {
  flushActivePoints(true);
  activeCampusId = null;
  setActiveSessionId(null);
  stopFlushTimer();
  await flushRouteTelemetryQueue();
};
