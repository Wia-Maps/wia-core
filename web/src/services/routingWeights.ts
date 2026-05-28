import { clientConfig } from '../config/client';
import { toApiUrl } from '../config/api';

export interface RoutingWeightOverlayEdgeRecord {
  edgeId: string;
  baseDistanceM: number;
  effectiveWeightM: number;
  popularityBoost: number;
  congestionPenalty: number;
  popularityCount7d: number;
  congestionCount15m: number;
  source: string;
  updatedAt: string;
}

export interface RoutingWeightOverlayRecord {
  campusId: string;
  version: string;
  updatedAt: string;
  generatedAt: string;
  metadata: Record<string, unknown> | null;
  edges: RoutingWeightOverlayEdgeRecord[];
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const ROUTING_WEIGHT_OVERLAY_UPDATED_EVENT = 'wia:routing-weight-overlay-updated';

const ROUTING_WEIGHT_OVERLAY_CACHE_KEY = 'wia_routing_weight_overlay_cache';

const isPersistenceEnabled = (): boolean => {
  return clientConfig.offline.enabled && clientConfig.offline.persistence;
};

const cacheKey = (campusId: string): string => `${ROUTING_WEIGHT_OVERLAY_CACHE_KEY}:${campusId}`;

const readJsonResponse = async <T>(response: Response): Promise<T | null> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  return (await response.json()) as T;
};

export const fetchPublicRoutingWeightOverlay = async (
  campusId = clientConfig.campus_id
): Promise<RoutingWeightOverlayRecord> => {
  const response = await fetch(
    toApiUrl(`/map/routing-weights?campusId=${encodeURIComponent(campusId)}`),
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  const payload = await readJsonResponse<ApiEnvelope<RoutingWeightOverlayRecord>>(response);

  if (!response.ok || !payload?.success || !payload.data) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return payload.data;
};

export const readCachedRoutingWeightOverlay = (
  campusId = clientConfig.campus_id
): RoutingWeightOverlayRecord | null => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(cacheKey(campusId));
    if (!rawValue) {
      return null;
    }

    return JSON.parse(rawValue) as RoutingWeightOverlayRecord;
  } catch {
    return null;
  }
};

export const writeCachedRoutingWeightOverlay = (
  overlay: RoutingWeightOverlayRecord
): void => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return;
  }

  try {
    window.localStorage.setItem(cacheKey(overlay.campusId), JSON.stringify(overlay));
  } catch {
    // Ignore persistence failures.
  }
};

export const publishRoutingWeightOverlayUpdated = (
  overlay: RoutingWeightOverlayRecord
): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<RoutingWeightOverlayRecord>(ROUTING_WEIGHT_OVERLAY_UPDATED_EVENT, {
      detail: overlay,
    })
  );
};
