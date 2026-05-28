import axios, { isAxiosError } from 'axios';
import { resolveApiBaseUrl } from '../config/api';
import type { MapDatasetMutationRecord, MapFeatureCollection } from './mapDatasets';
import type {
  FellowshipBrandRecord,
  FellowshipVenueEntry,
} from '../core/fellowshipUtils';

export interface AdminUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface AdminAuthPayload {
  admin: AdminUser;
}

export interface PowerReportRecord {
  _id: string;
  locationId: string;
  powerStatus: boolean;
  reportedAt: string;
  reportedBy?: string | null;
  note?: string | null;
  source?: string | null;
  scheduleId?: string | null;
}

export interface CampusLocationRecord {
  locationId: string;
  name: string;
  type: string;
  shortCode?: string | null;
  campusId?: string | null;
}

export type AdminLocationStatus = 'available' | 'unavailable' | 'no_report';
export type BulkPowerAction = 'turn_on' | 'turn_off' | 'mark_unavailable';

export interface AdminLocationRow {
  locationId: string;
  featureId: string;
  name: string;
  buildingId: string;
  shortCode: string | null;
  category: string;
  campusId: string | null;
  powerUpdateLocked: boolean;
  status: AdminLocationStatus;
  statusLabel: string;
  lastUpdated: string | null;
  operator: string | null;
  note: string | null;
}

export interface AdminLocationSummary {
  totalLocations: number;
  availableCount: number;
  unavailableCount: number;
  noReportCount: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminLocationListResponse extends PaginatedResponse<AdminLocationRow> {
  categories: string[];
  summary: AdminLocationSummary;
}

export interface AdminLocationDetailRecord {
  location: AdminLocationRow;
  metadata: {
    name: string;
    type: string;
    shortCode: string;
    campusId: string;
    powerUpdateLocked: boolean;
    fellowships: FellowshipVenueEntry[];
  };
}

export interface AdminLocationUpdateResult {
  location: AdminLocationRow;
  mutation: MapDatasetMutationRecord<MapFeatureCollection>;
}

export interface ActivityLogRecord {
  id: string;
  timestamp: string;
  operator: string | null;
  actionType: string;
  actionLabel: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  details: string;
  metadata: Record<string, unknown> | null;
}

export interface AdminActivityResponse extends PaginatedResponse<ActivityLogRecord> {
  actionTypes: string[];
}

export interface AdminActivityRevertResult {
  kind: 'dataset' | 'power';
  message: string;
  affectedCount: number | null;
  datasetMutation: MapDatasetMutationRecord<MapFeatureCollection> | null;
}

export interface PowerScheduleRecord {
  id: string;
  locationIds: string[];
  action: BulkPowerAction;
  actionLabel: string;
  recurrence: PowerScheduleRecurrence;
  recurrenceLabel: string;
  scheduledFor: string;
  timezone: string;
  note: string | null;
  status: 'scheduled' | 'executed' | 'failed' | 'cancelled';
  actor: {
    adminId: string | null;
    email: string | null;
  } | null;
  executedAt: string | null;
  cancelledAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PowerScheduleListResponse extends PaginatedResponse<PowerScheduleRecord> {}
export type PowerScheduleRecurrence = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface BulkPowerReportResult {
  reports: PowerReportRecord[];
  affectedCount: number;
  reportedAt: string;
}

export interface FellowshipBrandUploadInput {
  name?: string;
  contact?: string;
  fileDataUrl: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface AdminLoginInput {
  email: string;
  password: string;
}

export interface PowerReportInput {
  locationId: string;
  powerStatus: boolean;
  reportedBy?: string;
  note?: string;
}

export interface LocationTableQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: AdminLocationStatus | '';
  category?: string;
  sortBy?: 'name' | 'buildingId' | 'category' | 'status' | 'lastUpdated' | 'operator';
  sortDir?: 'asc' | 'desc';
}

export interface ActivityTableQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  actionType?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface PowerScheduleQuery {
  page?: number;
  pageSize?: number;
  status?: PowerScheduleRecord['status'] | '';
}

export interface CreatePowerScheduleInput {
  locationIds: string[];
  action: BulkPowerAction;
  recurrence: PowerScheduleRecurrence;
  scheduledFor: string;
  timezone: string;
  note?: string;
}

export interface BulkPowerReportInput {
  locationIds: string[];
  powerStatus: boolean;
  note?: string;
}

export interface UpdatePowerLocationLockInput {
  locationIds: string[];
  locked: boolean;
}

export interface UpdatePowerLocationLockResult {
  affectedCount: number;
  powerUpdateLocked: boolean;
  locations: AdminLocationRow[];
}

const adminApiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  withCredentials: true,
});

export const getAdminApiError = (error: unknown): string => {
  if (isAxiosError(error)) {
    return (error.response?.data as { error?: string } | undefined)?.error || error.message;
  }

  return error instanceof Error ? error.message : 'Request failed';
};

export const loginAdminRequest = async (payload: AdminLoginInput): Promise<AdminAuthPayload> => {
  const response = await adminApiClient.post<ApiResponse<AdminAuthPayload>>('/admin/login', payload);
  return { admin: response.data.data.admin };
};

export const fetchAdminSession = async (): Promise<AdminUser> => {
  const response = await adminApiClient.get<ApiResponse<{ admin: AdminUser }>>('/admin/me');
  return response.data.data.admin;
};

export const logoutAdminRequest = async (): Promise<void> => {
  await adminApiClient.post('/admin/logout');
};

export const fetchCampusLocations = async (): Promise<CampusLocationRecord[]> => {
  const response = await adminApiClient.get<ApiResponse<CampusLocationRecord[]>>('/locations');
  return response.data.data;
};

export const fetchRecentPowerReports = async (limit = 25): Promise<PowerReportRecord[]> => {
  const response = await adminApiClient.get<ApiResponse<PowerReportRecord[]>>('/power/recent', {
    params: { limit },
  });

  return response.data.data;
};

export const submitPowerReport = async (payload: PowerReportInput): Promise<PowerReportRecord> => {
  const response = await adminApiClient.post<ApiResponse<PowerReportRecord>>('/power/report', payload);
  return response.data.data;
};

export const fetchAdminLocations = async (query: LocationTableQuery = {}): Promise<AdminLocationListResponse> => {
  const response = await adminApiClient.get<ApiResponse<AdminLocationListResponse>>('/admin/locations', {
    params: query,
  });
  return response.data.data;
};

export const fetchAdminLocation = async (locationId: string): Promise<AdminLocationDetailRecord> => {
  const response = await adminApiClient.get<ApiResponse<AdminLocationDetailRecord>>(
    `/admin/locations/${encodeURIComponent(locationId)}`
  );
  return response.data.data;
};

export const updateAdminLocation = async (
  locationId: string,
  payload: AdminLocationDetailRecord['metadata']
): Promise<AdminLocationUpdateResult> => {
  const response = await adminApiClient.put<ApiResponse<AdminLocationUpdateResult>>(
    `/admin/locations/${encodeURIComponent(locationId)}`,
    payload
  );
  return response.data.data;
};

export const fetchAdminFellowshipBrands = async (): Promise<FellowshipBrandRecord[]> => {
  const response = await adminApiClient.get<ApiResponse<FellowshipBrandRecord[]>>(
    '/admin/locations/fellowship-brands'
  );
  return response.data.data;
};

export const fetchAdminFellowshipBrand = async (code: string): Promise<FellowshipBrandRecord> => {
  const response = await adminApiClient.get<ApiResponse<FellowshipBrandRecord>>(
    `/admin/locations/fellowship-brands/${encodeURIComponent(code)}`
  );
  return response.data.data;
};

export const uploadAdminFellowshipBrandLogo = async (
  code: string,
  payload: FellowshipBrandUploadInput
): Promise<FellowshipBrandRecord> => {
  const response = await adminApiClient.post<ApiResponse<FellowshipBrandRecord>>(
    `/admin/locations/fellowship-brands/${encodeURIComponent(code)}/logo`,
    payload
  );
  return response.data.data;
};

export const removeAdminFellowshipBrandLogo = async (
  code: string
): Promise<FellowshipBrandRecord> => {
  const response = await adminApiClient.delete<ApiResponse<FellowshipBrandRecord>>(
    `/admin/locations/fellowship-brands/${encodeURIComponent(code)}/logo`
  );
  return response.data.data;
};

export const submitBulkPowerReport = async (
  payload: BulkPowerReportInput
): Promise<BulkPowerReportResult> => {
  const response = await adminApiClient.post<ApiResponse<BulkPowerReportResult>>(
    '/admin/power/bulk-report',
    payload
  );
  return response.data.data;
};

export const updatePowerLocationLockRequest = async (
  payload: UpdatePowerLocationLockInput
): Promise<UpdatePowerLocationLockResult> => {
  const response = await adminApiClient.post<ApiResponse<UpdatePowerLocationLockResult>>(
    '/admin/power/location-lock',
    payload
  );
  return response.data.data;
};

export const fetchPowerSchedules = async (query: PowerScheduleQuery = {}): Promise<PowerScheduleListResponse> => {
  const response = await adminApiClient.get<ApiResponse<PowerScheduleListResponse>>('/admin/power/schedules', {
    params: query,
  });
  return response.data.data;
};

export const createPowerScheduleRequest = async (
  payload: CreatePowerScheduleInput
): Promise<PowerScheduleRecord> => {
  const response = await adminApiClient.post<ApiResponse<PowerScheduleRecord>>(
    '/admin/power/schedules',
    payload
  );
  return response.data.data;
};

export const cancelPowerScheduleRequest = async (scheduleId: string): Promise<PowerScheduleRecord> => {
  const response = await adminApiClient.post<ApiResponse<PowerScheduleRecord>>(
    `/admin/power/schedules/${encodeURIComponent(scheduleId)}/cancel`
  );
  return response.data.data;
};

export const fetchAdminActivity = async (query: ActivityTableQuery = {}): Promise<AdminActivityResponse> => {
  const response = await adminApiClient.get<ApiResponse<AdminActivityResponse>>('/admin/activity', {
    params: query,
  });
  return response.data.data;
};

export const revertAdminActivityRecord = async (activityId: string): Promise<AdminActivityRevertResult> => {
  const response = await adminApiClient.post<ApiResponse<AdminActivityRevertResult>>(
    `/admin/activity/${encodeURIComponent(activityId)}/revert`
  );
  return response.data.data;
};

export default adminApiClient;
