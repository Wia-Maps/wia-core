import { toApiUrl } from '../config/api';
import type { ApiResponse } from './api';

export interface LiveShareSessionPayload {
  sessionId: string;
  lat: number;
  lng: number;
  sos: boolean;
  broadcasterToken?: string;
}

export interface LiveShareSessionResponse {
  sessionId: string;
  broadcasterToken: string;
  shareToken: string;
  expiresAt: number;
}

export interface ResolvedLiveShareResponse {
  sessionId: string;
  coordinates: [number, number];
  isSos: boolean;
  viewerToken: string;
  expiresAt: number;
}

const postJson = async <T, TBody extends object>(path: string, body: TBody): Promise<T> => {
  const response = await fetch(toApiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(payload.error || 'Request failed.');
  }

  return payload.data;
};

export const createLiveShareSession = async (
  payload: LiveShareSessionPayload,
): Promise<LiveShareSessionResponse> => {
  return postJson('/map/live-share/session', payload);
};

export const resolveLiveShareSession = async (liveToken: string): Promise<ResolvedLiveShareResponse> => {
  return postJson('/map/live-share/resolve', { liveToken });
};
