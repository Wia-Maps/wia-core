import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { useToast } from '../../context/ToastContext';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { writeCachedMapDataset } from '../../services/mapDatasetCache';
import { publishMapDatasetUpdated } from '../../services/mapDatasetEvents';
import type { SavedFilterRecord } from '../../services/adminPreferences';
import {
  fetchAdminActivity,
  getAdminApiError,
  revertAdminActivityRecord,
  type ActivityLogRecord,
} from '../../services/adminApi';
import {
  ActionMenu,
  ConfirmationModal,
  DataTable,
  FilterDropdown,
  SearchInput,
  SidePanelEditor,
  TextEntryModal,
} from './AdminOpsComponents';
import { formatAdminDateTime, formatAdminRelativeTime } from './adminPageUtils';
import { AdminEmptyState, AdminSectionCard, AdminStatusBadge } from './AdminUi';

interface AdminActivityLogPageProps {
  enabled: boolean;
  dense: boolean;
  defaultPageSize: number;
  autoRefresh: boolean;
  savedFilters: SavedFilterRecord[];
  onSaveFilter: (page: 'activity', name: string, query: Record<string, unknown>) => void;
  onWorkspaceRefresh: () => Promise<void>;
}

const opaqueRecordIdPattern = /^[a-f0-9]{24}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const formatActivityTargetLabel = (targetLabel: string | null | undefined, targetId: string | null | undefined): string => {
  if (typeof targetLabel === 'string' && targetLabel.trim()) {
    return targetLabel.trim();
  }

  if (typeof targetId === 'string' && targetId.trim()) {
    return opaqueRecordIdPattern.test(targetId.trim()) ? 'Linked record' : targetId.trim();
  }

  return 'System';
};

const isRestorableActivity = (record: ActivityLogRecord): boolean => {
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  if (!metadata) {
    return false;
  }

  if (typeof metadata.datasetType === 'string' && typeof metadata.revisionId === 'string') {
    return true;
  }

  if ((record.actionType === 'power_update' || record.actionType === 'power_restore')
    && typeof metadata.locationId === 'string'
    && typeof metadata.powerStatus === 'boolean') {
    return true;
  }

  return (record.actionType === 'bulk_power_update' || record.actionType === 'bulk_power_restore')
    && Array.isArray(metadata.locationIds)
    && metadata.locationIds.some((entry) => typeof entry === 'string' && entry.trim().length > 0)
    && typeof metadata.powerStatus === 'boolean';
};

const restoreActionLabel = (record: ActivityLogRecord): string => {
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  return metadata && typeof metadata.datasetType === 'string' && typeof metadata.revisionId === 'string'
    ? 'Restore this state'
    : 'Apply this state';
};

const restoreActionMessage = (record: ActivityLogRecord): string => {
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  if (metadata && typeof metadata.datasetType === 'string' && typeof metadata.revisionId === 'string') {
    return `Restore the live ${formatActivityTargetLabel(record.targetLabel, record.targetId)} dataset to the state captured by this activity? This publishes immediately.`;
  }

  return `Apply the state captured by this activity to the live system now? This creates a new live update immediately.`;
};

export default function AdminActivityLogPage({
  enabled,
  dense,
  defaultPageSize,
  autoRefresh,
  savedFilters,
  onSaveFilter,
  onWorkspaceRefresh,
}: AdminActivityLogPageProps): JSX.Element {
  const { showError, showSuccess } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [actionType, setActionType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [response, setResponse] = useState<Awaited<ReturnType<typeof fetchAdminActivity>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeRecord, setActiveRecord] = useState<ActivityLogRecord | null>(null);
  const [pendingRestoreRecord, setPendingRestoreRecord] = useState<ActivityLogRecord | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(searchQuery, 250);

  const activitySavedFilters = useMemo(() => {
    return savedFilters.filter((filter) => filter.page === 'activity');
  }, [savedFilters]);

  const loadActivity = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }

    setLoading(true);

    try {
      const nextResponse = await fetchAdminActivity({
        page: pageIndex + 1,
        pageSize,
        search: debouncedSearch.trim(),
        actionType,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });

      setResponse(nextResponse);
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Activity log',
        dedupeKey: 'admin-activity-log',
      });
    } finally {
      setLoading(false);
    }
  }, [actionType, dateFrom, dateTo, debouncedSearch, enabled, pageIndex, pageSize, showError]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    setPageIndex(0);
  }, [actionType, dateFrom, dateTo, debouncedSearch]);

  useEffect(() => {
    if (!enabled || !autoRefresh) {
      return;
    }

    const handle = window.setInterval(() => {
      void loadActivity();
    }, 60000);

    return () => {
      window.clearInterval(handle);
    };
  }, [autoRefresh, enabled, loadActivity]);

  const handleSaveCurrentView = (): void => {
    const name = saveViewName.trim();
    if (!name) {
      return;
    }

    onSaveFilter('activity', name, {
      search: debouncedSearch.trim(),
      actionType,
      dateFrom,
      dateTo,
    });

    showSuccess(`Saved "${name.trim()}" for the Activity Log.`, {
      title: 'Saved filter',
      dedupeKey: `activity-saved-filter-${name.trim()}`,
    });
    setSaveViewOpen(false);
    setSaveViewName('');
  };

  const applySavedFilter = (filterId: string): void => {
    if (!filterId) {
      return;
    }

    const filter = activitySavedFilters.find((entry) => entry.id === filterId);
    if (!filter) {
      return;
    }

    const query = filter.query ?? {};
    setSearchQuery(typeof query.search === 'string' ? query.search : '');
    setActionType(typeof query.actionType === 'string' ? query.actionType : '');
    setDateFrom(typeof query.dateFrom === 'string' ? query.dateFrom : '');
    setDateTo(typeof query.dateTo === 'string' ? query.dateTo : '');
    setPageIndex(0);
  };

  const handleRestoreActivity = useCallback(async (record: ActivityLogRecord): Promise<void> => {
    setRestoring(true);

    try {
      const result = await revertAdminActivityRecord(record.id);

      if (result.kind === 'dataset' && result.datasetMutation) {
        await writeCachedMapDataset(result.datasetMutation.dataset);
        publishMapDatasetUpdated(result.datasetMutation.dataset);
      }

      await loadActivity();
      void onWorkspaceRefresh();

      showSuccess(result.message, {
        title: 'Activity restored',
        dedupeKey: `admin-activity-restore-${record.id}`,
      });

      setPendingRestoreRecord(null);
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Restore failed',
        dedupeKey: `admin-activity-restore-error-${record.id}`,
      });
    } finally {
      setRestoring(false);
    }
  }, [loadActivity, onWorkspaceRefresh, showError, showSuccess]);

  const columns = useMemo<ColumnDef<ActivityLogRecord>[]>(
    () => [
      {
        id: 'timestamp',
        accessorKey: 'timestamp',
        header: 'Timestamp',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-slate-900">{formatAdminDateTime(row.original.timestamp)}</p>
            <p className="mt-1 text-xs text-slate-500">{formatAdminRelativeTime(row.original.timestamp)}</p>
          </div>
        ),
      },
      {
        id: 'operator',
        accessorKey: 'operator',
        header: 'Operator',
        cell: ({ row }) => <span>{row.original.operator ?? 'System'}</span>,
      },
      {
        id: 'actionLabel',
        accessorKey: 'actionLabel',
        header: 'Action',
        cell: ({ row }) => (
          <div>
            <p className="font-semibold text-slate-950">{row.original.actionLabel}</p>
            <p className="mt-1 text-xs text-slate-500">{row.original.actionType}</p>
          </div>
        ),
      },
      {
        id: 'targetLabel',
        accessorKey: 'targetLabel',
        header: 'Target',
        cell: ({ row }) => <span>{formatActivityTargetLabel(row.original.targetLabel, row.original.targetId)}</span>,
      },
      {
        id: 'details',
        accessorKey: 'details',
        header: 'Details',
        cell: ({ row }) => <span className="block max-w-[420px] text-sm text-slate-700">{row.original.details}</span>,
      },
      {
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => (
          <ActionMenu
            items={[
              {
                label: 'View details',
                onSelect: () => setActiveRecord(row.original),
              },
              ...(isRestorableActivity(row.original)
                ? [{
                    label: restoreActionLabel(row.original),
                    onSelect: () => setPendingRestoreRecord(row.original),
                    tone: 'danger' as const,
                  }]
                : []),
            ]}
          />
        ),
      },
    ],
    []
  );

  if (!enabled) {
    return (
      <AdminSectionCard
        label="Activity log"
        title="Audit history"
      >
        <AdminEmptyState
          title="Sign in to review audit history"
          message="Sign in to view the audit log."
        />
      </AdminSectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <AdminSectionCard>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <AdminStatusBadge>{response?.total ?? 0} records</AdminStatusBadge>
              {actionType ? <AdminStatusBadge tone="info">{actionType}</AdminStatusBadge> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void loadActivity();
                }}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => setSaveViewOpen(true)}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
              >
                Save view
              </button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,0.85fr)_minmax(0,0.95fr)]">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              label="Search"
              placeholder="Search activity log"
              className="min-w-0 md:col-span-2 xl:col-span-1"
            />
            <FilterDropdown
              label="Action type"
              value={actionType}
              options={[
                { label: 'All actions', value: '' },
                ...((response?.actionTypes ?? []).map((value) => ({
                  label: value,
                  value,
                })) ?? []),
              ]}
              onChange={setActionType}
              className="min-w-0"
            />
            <label className="block min-w-0">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                From
              </span>
              <input
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                To
              </span>
              <input
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Saved views
              </span>
              <select
                defaultValue=""
                onChange={(event) => {
                  applySavedFilter(event.target.value);
                  event.target.value = '';
                }}
                className="w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              >
                <option value="">Select view</option>
                {activitySavedFilters.map((filter) => (
                  <option key={filter.id} value={filter.id}>
                    {filter.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <DataTable
            data={response?.items ?? []}
            columns={columns}
            pageIndex={pageIndex}
            pageSize={pageSize}
            pageCount={response?.totalPages ?? 1}
            rowCount={response?.total ?? 0}
            sorting={[] as SortingState}
            onSortingChange={() => undefined}
            onPageIndexChange={setPageIndex}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPageIndex(0);
            }}
            loading={loading}
            dense={dense}
            emptyState={
              <AdminEmptyState
                title="No matching activity"
                message="Adjust the filters or date range to find a different slice of the audit log."
              />
            }
          />
        </div>
      </AdminSectionCard>

      <SidePanelEditor
        open={Boolean(activeRecord)}
        title="Activity details"
        onClose={() => setActiveRecord(null)}
      >
        {!activeRecord ? null : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <AdminStatusBadge>{activeRecord.actionLabel}</AdminStatusBadge>
              <AdminStatusBadge tone="info">{activeRecord.targetType}</AdminStatusBadge>
              {isRestorableActivity(activeRecord) ? (
                <button
                  type="button"
                  onClick={() => setPendingRestoreRecord(activeRecord)}
                  className="rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-800 transition hover:border-amber-300 hover:bg-amber-100"
                >
                  {restoreActionLabel(activeRecord)}
                </button>
              ) : null}
            </div>

            <div className="space-y-3 text-sm text-slate-700">
              <p>
                <span className="font-semibold text-slate-900">Timestamp:</span>{' '}
                {formatAdminDateTime(activeRecord.timestamp)}
              </p>
              <p>
                <span className="font-semibold text-slate-900">Operator:</span>{' '}
                {activeRecord.operator ?? 'System'}
              </p>
              <p>
                <span className="font-semibold text-slate-900">Target:</span>{' '}
                {formatActivityTargetLabel(activeRecord.targetLabel, activeRecord.targetId)}
              </p>
              <p>
                <span className="font-semibold text-slate-900">Details:</span> {activeRecord.details}
              </p>
            </div>

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Metadata
              </p>
              <pre className="overflow-x-auto rounded-2xl border border-slate-200 bg-slate-950 px-4 py-4 text-xs text-slate-100">
                {JSON.stringify(activeRecord.metadata ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </SidePanelEditor>
      <ConfirmationModal
        open={Boolean(pendingRestoreRecord)}
        title={pendingRestoreRecord ? restoreActionLabel(pendingRestoreRecord) : 'Restore this state'}
        message={pendingRestoreRecord ? restoreActionMessage(pendingRestoreRecord) : ''}
        confirmLabel={pendingRestoreRecord ? restoreActionLabel(pendingRestoreRecord) : 'Restore'}
        onCancel={() => setPendingRestoreRecord(null)}
        onConfirm={() => {
          if (!pendingRestoreRecord) {
            return;
          }

          void handleRestoreActivity(pendingRestoreRecord);
        }}
        tone="default"
        busy={restoring}
      />
      <TextEntryModal
        open={saveViewOpen}
        title="Save activity view"
        description="Save the current filters so you can open this audit slice again quickly."
        label="View name"
        value={saveViewName}
        placeholder="For example: Morning admin review"
        confirmLabel="Save view"
        confirmDisabled={!saveViewName.trim()}
        onCancel={() => {
          setSaveViewOpen(false);
          setSaveViewName('');
        }}
        onChange={setSaveViewName}
        onConfirm={handleSaveCurrentView}
      />
    </div>
  );
}
