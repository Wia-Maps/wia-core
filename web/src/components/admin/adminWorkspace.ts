import type {
  AdminActivityResponse,
  AdminLocationListResponse,
  CampusLocationRecord,
  PowerReportRecord,
} from '../../services/adminApi';
import type { LoadState } from '../../core/loadState';
import type { MapDatasetType } from '../../services/mapDatasets';
import {
  formatCompactDateTime,
  formatRelativeTime as formatSharedRelativeTime,
} from '../../utils/dateTime';

export type AdminRoute =
  | 'dashboard'
  | 'locations'
  | 'power'
  | 'routes'
  | 'datasets'
  | 'activity'
  | 'settings';

export interface AdminRouteMeta {
  route: AdminRoute;
  label: string;
  navLabel: string;
  description: string;
}

export interface AdminDatasetSummary {
  datasetType: MapDatasetType;
  version: string;
  updatedAt: string;
  featureCount: number;
}

export interface AdminDatasetManagerFocusRequest {
  datasetType: MapDatasetType;
  featureId: string;
  revealSection?: 'access-points';
}

export interface AdminWorkspaceState {
  isAuthenticated: boolean;
  adminEmail: string | null;
  locations: CampusLocationRecord[];
  reports: PowerReportRecord[];
  locationsResponse: AdminLocationListResponse | null;
  activityResponse: AdminActivityResponse | null;
  locationsById: Map<string, CampusLocationRecord>;
  reportsByLocationId: Map<string, PowerReportRecord>;
  availableCount: number;
  unavailableCount: number;
  noReportCount: number;
  latestActivity: PowerReportRecord | null;
  datasetSummaries: AdminDatasetSummary[];
  latestDatasetSummary: AdminDatasetSummary | null;
  lastRefreshedAt: string | null;
  loadState: LoadState;
  loading: boolean;
  catalogLoading: boolean;
  updatingLocationId: string | null;
}

export const ADMIN_ROUTE_META: Record<AdminRoute, AdminRouteMeta> = {
  dashboard: {
    route: 'dashboard',
    label: 'Dashboard',
    navLabel: 'Dashboard',
    description: 'System overview with key metrics and quick operational entry points.',
  },
  locations: {
    route: 'locations',
    label: 'Locations',
    navLabel: 'Locations',
    description: 'Search, filter, edit metadata, and run bulk actions across campus locations.',
  },
  power: {
    route: 'power',
    label: 'Power Control',
    navLabel: 'Power Control',
    description: 'Handle live status changes, instant toggles, and scheduled power updates.',
  },
  routes: {
    route: 'routes',
    label: 'Route Workflows',
    navLabel: 'Routes',
    description: 'Review candidate paths, publish approved routes, and record new paths for routing updates.',
  },
  datasets: {
    route: 'datasets',
    label: 'Datasets',
    navLabel: 'Datasets',
    description: 'Browse map features, edit metadata, and publish dataset revisions.',
  },
  activity: {
    route: 'activity',
    label: 'Activity Log',
    navLabel: 'Activity Log',
    description: 'Track admin actions, bulk updates, publishes, and schedule execution history.',
  },
  settings: {
    route: 'settings',
    label: 'Settings',
    navLabel: 'Settings',
    description: 'Manage dense mode, saved filters, live updates, and admin workspace preferences.',
  },
};

export const formatDatasetLabel = (datasetType: MapDatasetType): string => {
  return datasetType === 'locations' ? 'Locations dataset' : 'Routing dataset';
};

export const formatAbsoluteTime = (value: string): string => {
  return formatCompactDateTime(value);
};

export const formatRelativeTime = (value: string): string => {
  return formatSharedRelativeTime(value);
};
