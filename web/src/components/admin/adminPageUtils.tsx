import type {
  AdminLocationRow,
  AdminLocationStatus,
  BulkPowerAction,
} from '../../services/adminApi';
import { formatAbsoluteTime, formatRelativeTime } from './adminWorkspace';
import { AdminStatusBadge } from './AdminUi';

export const ADMIN_LOCATION_FOCUS_EVENT = 'wia:admin-focus-location';

export const publishAdminLocationFocus = (locationId: string): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<{ locationId: string }>(ADMIN_LOCATION_FOCUS_EVENT, {
      detail: {
        locationId,
      },
    })
  );
};

export const formatAdminDateTime = (value: string | null): string => {
  if (!value) {
    return 'No report';
  }

  return formatAbsoluteTime(value);
};

export const formatAdminRelativeTime = (value: string | null): string => {
  if (!value) {
    return 'No report';
  }

  return formatRelativeTime(value);
};

export const locationStatusTone = (
  status: AdminLocationStatus
): 'success' | 'danger' | 'warning' => {
  if (status === 'available') {
    return 'success';
  }

  if (status === 'unavailable') {
    return 'danger';
  }

  return 'warning';
};

export const LocationStatusBadge: React.FC<{
  status: AdminLocationStatus;
  label?: string;
  pulse?: boolean;
}> = ({ status, label, pulse = false }) => {
  return (
    <AdminStatusBadge
      tone={locationStatusTone(status)}
      className={pulse ? 'animate-pulse' : undefined}
    >
      {label ?? (status === 'available' ? 'Available' : status === 'unavailable' ? 'Unavailable' : 'No report')}
    </AdminStatusBadge>
  );
};

export const bulkActionLabel = (action: BulkPowerAction): string => {
  if (action === 'turn_on') {
    return 'Turn ON power';
  }

  if (action === 'turn_off') {
    return 'Turn OFF power';
  }

  return 'Mark unavailable';
};

export const applyPowerStateToLocationRow = (
  row: AdminLocationRow,
  powerStatus: boolean,
  operator?: string | null,
  reportedAt?: string,
  note?: string | null
): AdminLocationRow => {
  return {
    ...row,
    status: powerStatus ? 'available' : 'unavailable',
    statusLabel: powerStatus ? 'Available' : 'Unavailable',
    operator: operator ?? row.operator,
    lastUpdated: reportedAt ?? new Date().toISOString(),
    note: typeof note === 'undefined' ? row.note : note,
  };
};

const escapeCsvValue = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
};

export const exportLocationRowsCsv = (rows: AdminLocationRow[], filename = 'locations-export.csv'): void => {
  const header = ['Name', 'Building ID', 'Category', 'Status', 'Last Updated', 'Operator', 'Location ID'];
  const lines = rows.map((row) =>
    [
      row.name,
      row.buildingId,
      row.category,
      row.statusLabel,
      formatAdminDateTime(row.lastUpdated),
      row.operator ?? '',
      row.locationId,
    ]
      .map((value) => escapeCsvValue(String(value)))
      .join(',')
  );

  const csv = [header.join(','), ...lines].join('\n');

  if (typeof window === 'undefined') {
    return;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
};
