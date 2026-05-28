import type { LineString } from 'geojson';
import { toApiUrl } from '../config/api';
import type { MapDatasetMutationRecord, MapFeatureCollection } from './mapDatasets';
import type { RoutingWeightOverlayRecord } from './routingWeights';

export interface RouteAnchorRecord {
  nodeId: string | null;
  locationId: string | null;
  coordinates: [number, number];
  snapped: boolean;
  distanceM: number;
}

export interface RouteCandidateRecord {
  id: string;
  campusId: string;
  title: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  source: 'analytics_discovery' | 'admin_recording';
  geometry: LineString;
  startAnchor: RouteAnchorRecord;
  endAnchor: RouteAnchorRecord;
  routeProperties: {
    name: string;
    accessible: boolean;
    stairs: boolean;
    ramp: boolean;
    elevator: boolean;
  };
  observedCount: number;
  distinctSessionCount: number;
  confidence: number;
  averageDistanceM: number;
  averageDurationS: number;
  averageAccuracyM: number;
  improvementDistanceM: number;
  telemetrySourceIds: string[];
  review: {
    reviewedAt: string | null;
    reviewedBy: {
      adminId: string | null;
      email: string | null;
    } | null;
    notes: string;
    rejectionReason: string;
  } | null;
  publish: {
    publishedAt: string | null;
    publishedBy: {
      adminId: string | null;
      email: string | null;
    } | null;
    routingRevisionId: string | null;
    featureIds: string[];
    overlayVersion: string | null;
  } | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouteCandidateListResponse {
  items: RouteCandidateRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  statuses: string[];
  sources: string[];
}

export interface SaveRouteRecordingDraftInput {
  draftId?: string;
  campusId?: string;
  title?: string;
  geometry?: LineString;
  points?: Array<{ latitude: number; longitude: number }>;
  routeProperties?: Partial<RouteCandidateRecord['routeProperties']>;
  observedCount?: number;
  distinctSessionCount?: number;
  confidence?: number;
  averageDistanceM?: number;
  averageDurationS?: number;
  averageAccuracyM?: number;
  metadata?: Record<string, unknown> | null;
}

export interface SubmitRouteRecordingInput extends SaveRouteRecordingDraftInput {
  observedCount?: number;
  confidence?: number;
}

export interface ApproveRouteCandidateResult {
  candidate: RouteCandidateRecord;
  datasetMutation: MapDatasetMutationRecord<MapFeatureCollection>;
  overlay: RoutingWeightOverlayRecord;
}

export interface UpdateRouteCandidateInput extends Partial<RouteCandidateRecord> {
  reviewNotes?: string;
}

export interface ApproveRouteCandidateInput extends Partial<RouteCandidateRecord> {
  name?: string;
  accessible?: boolean;
  stairs?: boolean;
  ramp?: boolean;
  elevator?: boolean;
  notes?: string;
}

export interface RejectRouteCandidateInput {
  notes?: string;
  rejectionReason?: string;
  reason?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.success || typeof payload.data === 'undefined') {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }

  return payload.data;
};

export const fetchAdminRouteCandidates = async (params?: {
  status?: string;
  source?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  campusId?: string;
}): Promise<RouteCandidateListResponse> => {
  const search = new URLSearchParams();
  if (params?.status) search.set('status', params.status);
  if (params?.source) search.set('source', params.source);
  if (params?.search) search.set('search', params.search);
  if (typeof params?.page === 'number') search.set('page', String(params.page));
  if (typeof params?.pageSize === 'number') search.set('pageSize', String(params.pageSize));
  if (params?.campusId) search.set('campusId', params.campusId);

  const suffix = search.toString() ? `?${search.toString()}` : '';
  return requestJson<RouteCandidateListResponse>(toApiUrl(`/admin/routes/candidates${suffix}`), {
    method: 'GET',
  });
};

export const fetchAdminRouteCandidate = async (
  candidateId: string
): Promise<RouteCandidateRecord> => {
  return requestJson<RouteCandidateRecord>(
    toApiUrl(`/admin/routes/candidates/${encodeURIComponent(candidateId)}`),
    {
      method: 'GET',
    }
  );
};

export const updateAdminRouteCandidate = async (
  candidateId: string,
  payload: UpdateRouteCandidateInput
): Promise<RouteCandidateRecord> => {
  return requestJson<RouteCandidateRecord>(
    toApiUrl(`/admin/routes/candidates/${encodeURIComponent(candidateId)}`),
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
};

export const approveAdminRouteCandidate = async (
  candidateId: string,
  payload?: ApproveRouteCandidateInput
): Promise<ApproveRouteCandidateResult> => {
  return requestJson<ApproveRouteCandidateResult>(
    toApiUrl(`/admin/routes/candidates/${encodeURIComponent(candidateId)}/approve`),
    {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }
  );
};

export const rejectAdminRouteCandidate = async (
  candidateId: string,
  payload?: RejectRouteCandidateInput
): Promise<RouteCandidateRecord> => {
  return requestJson<RouteCandidateRecord>(
    toApiUrl(`/admin/routes/candidates/${encodeURIComponent(candidateId)}/reject`),
    {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }
  );
};

export const saveAdminRouteRecordingDraft = async (
  payload: SaveRouteRecordingDraftInput
): Promise<RouteCandidateRecord> => {
  return requestJson<RouteCandidateRecord>(toApiUrl('/admin/routes/recordings/drafts'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
};

export const deleteAdminRouteRecordingDraft = async (
  draftId: string
): Promise<RouteCandidateRecord> => {
  return requestJson<RouteCandidateRecord>(
    toApiUrl(`/admin/routes/recordings/drafts/${encodeURIComponent(draftId)}`),
    {
      method: 'DELETE',
    }
  );
};

export const submitAdminRouteRecording = async (
  payload: SubmitRouteRecordingInput
): Promise<RouteCandidateRecord> => {
  return requestJson<RouteCandidateRecord>(toApiUrl('/admin/routes/recordings/submit'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
};
