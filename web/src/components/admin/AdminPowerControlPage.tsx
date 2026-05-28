import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import { useToast } from '../../context/ToastContext';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { subscribeToPowerSignals } from '../../services/powerStatus';
import type { SavedFilterRecord } from '../../services/adminPreferences';
import {
  cancelPowerScheduleRequest,
  createPowerScheduleRequest,
  fetchAdminLocations,
  fetchPowerSchedules,
  getAdminApiError,
  submitBulkPowerReport,
  submitPowerReport,
  updatePowerLocationLockRequest,
  type AdminLocationRow,
  type AdminLocationStatus,
  type BulkPowerAction,
  type LocationTableQuery,
  type PowerScheduleRecurrence,
  type PowerScheduleRecord,
} from '../../services/adminApi';
import {
  BulkActionBar,
  DataTable,
  FilterDropdown,
  LiveIndicator,
  SearchInput,
  SidePanelEditor,
  TextEntryModal,
} from './AdminOpsComponents';
import { PanelSkeleton } from '../LoadingPrimitives';
import {
  LocationStatusBadge,
  applyPowerStateToLocationRow,
  bulkActionLabel,
  formatAdminDateTime,
  formatAdminRelativeTime,
} from './adminPageUtils';
import { AdminEmptyState, AdminSectionCard, AdminStatusBadge, cx } from './AdminUi';
import {
  formatDateTimeInputValue,
  getDisplayTimezone,
  parseDateTimeInputValueToUtcIso,
} from '../../utils/dateTime';

interface AdminPowerControlPageProps {
  enabled: boolean;
  dense: boolean;
  defaultPageSize: number;
  autoRefresh: boolean;
  savedFilters: SavedFilterRecord[];
  onSaveFilter: (page: 'power', name: string, query: Record<string, unknown>) => void;
  onWorkspaceRefresh: () => Promise<void>;
}

interface ScheduleDraft {
  open: boolean;
  action: BulkPowerAction;
  recurrence: PowerScheduleRecurrence;
  scheduledFor: string;
  note: string;
}

const statusOptions: Array<{ label: string; value: AdminLocationStatus | '' }> = [
  { label: 'All statuses', value: '' },
  { label: 'Available', value: 'available' },
  { label: 'Unavailable', value: 'unavailable' },
  { label: 'No report', value: 'no_report' },
];

const toSortQuery = (
  sorting: SortingState
): Pick<LocationTableQuery, 'sortBy' | 'sortDir'> => {
  const active = sorting[0];
  const sortByMap: Record<string, LocationTableQuery['sortBy']> = {
    name: 'name',
    status: 'status',
    lastUpdated: 'lastUpdated',
    operator: 'operator',
  };

  return {
    sortBy: sortByMap[active?.id ?? 'lastUpdated'] ?? 'lastUpdated',
    sortDir: active?.desc ? 'desc' : 'asc',
  };
};

const toSortingState = (query: Record<string, unknown>): SortingState => {
  const sortBy = typeof query.sortBy === 'string' ? query.sortBy : 'lastUpdated';
  const sortDir = query.sortDir === 'desc' ? 'desc' : 'asc';
  return [{ id: sortBy, desc: sortDir === 'desc' }];
};

const buildDefaultScheduleTime = (): string => {
  return formatDateTimeInputValue(Date.now() + 30 * 60 * 1000);
};

const buildDefaultScheduleDraft = (): ScheduleDraft => ({
  open: false,
  action: 'turn_off',
  recurrence: 'once',
  scheduledFor: buildDefaultScheduleTime(),
  note: '',
});

const scheduleRecurrenceOptions: Array<{ label: string; value: PowerScheduleRecurrence }> = [
  { label: 'One time', value: 'once' },
  { label: 'Every day', value: 'daily' },
  { label: 'Weekdays', value: 'weekdays' },
  { label: 'Every week', value: 'weekly' },
  { label: 'Every month', value: 'monthly' },
];

const scheduleStatusTone = (
  status: PowerScheduleRecord['status']
): 'default' | 'success' | 'warning' | 'danger' => {
  if (status === 'executed') {
    return 'success';
  }

  if (status === 'cancelled') {
    return 'warning';
  }

  if (status === 'failed') {
    return 'danger';
  }

  return 'default';
};

export default function AdminPowerControlPage({
  enabled,
  dense,
  defaultPageSize,
  autoRefresh,
  savedFilters,
  onSaveFilter,
  onWorkspaceRefresh,
}: AdminPowerControlPageProps): JSX.Element {
  const { showError, showSuccess } = useToast();
  const displayTimezone = getDisplayTimezone();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AdminLocationStatus | ''>('');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'lastUpdated', desc: true }]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [response, setResponse] = useState<Awaited<ReturnType<typeof fetchAdminLocations>> | null>(null);
  const [schedules, setSchedules] = useState<Awaited<ReturnType<typeof fetchPowerSchedules>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [mutatingLocationId, setMutatingLocationId] = useState<string | null>(null);
  const [runningBulkAction, setRunningBulkAction] = useState<BulkPowerAction | null>(null);
  const [runningLockAction, setRunningLockAction] = useState<boolean | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(buildDefaultScheduleDraft);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [lastSignalAt, setLastSignalAt] = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(searchQuery, 250);

  const powerSavedFilters = useMemo(() => {
    return savedFilters.filter((filter) => filter.page === 'power');
  }, [savedFilters]);

  const selectedRows = useMemo(() => {
    const selectedIds = new Set(
      Object.entries(rowSelection)
        .filter(([, selected]) => Boolean(selected))
        .map(([id]) => id)
    );

    return (response?.items ?? []).filter((row) => selectedIds.has(row.locationId));
  }, [response, rowSelection]);

  const loadLocations = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }

    setLoading(true);

    try {
      const nextResponse = await fetchAdminLocations({
        page: pageIndex + 1,
        pageSize,
        search: debouncedSearch.trim(),
        status: statusFilter,
        ...toSortQuery(sorting),
      });

      setResponse(nextResponse);
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Power control',
        dedupeKey: 'admin-power-table',
      });
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, enabled, pageIndex, pageSize, showError, sorting, statusFilter]);

  const loadSchedules = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }

    setScheduleLoading(true);

    try {
      const nextSchedules = await fetchPowerSchedules({
        page: 1,
        pageSize: 8,
      });
      setSchedules(nextSchedules);
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Power schedules',
        dedupeKey: 'admin-power-schedules',
      });
    } finally {
      setScheduleLoading(false);
    }
  }, [enabled, showError]);

  useEffect(() => {
    void Promise.all([loadLocations(), loadSchedules()]);
  }, [loadLocations, loadSchedules]);

  useEffect(() => {
    setPageIndex(0);
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    setRowSelection({});
  }, [pageIndex, pageSize, debouncedSearch, statusFilter]);

  useEffect(() => {
    if (!enabled || !autoRefresh) {
      return;
    }

    const handle = window.setInterval(() => {
      void Promise.all([loadLocations(), loadSchedules()]);
    }, 60000);

    return () => {
      window.clearInterval(handle);
    };
  }, [autoRefresh, enabled, loadLocations, loadSchedules]);

  useEffect(() => {
    if (!enabled || !autoRefresh) {
      setSocketConnected(false);
      return;
    }

    const socket = subscribeToPowerSignals({
      onOpen: () => {
        setSocketConnected(true);
      },
      onClose: () => {
        setSocketConnected(false);
      },
      onError: () => {
        setSocketConnected(false);
      },
      onReport: (report) => {
        setLastSignalAt(report.reportedAt);
        setResponse((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            items: current.items.map((row) =>
              row.locationId === report.locationId
                ? applyPowerStateToLocationRow(
                    row,
                    report.powerStatus,
                    report.reportedBy ?? null,
                    report.reportedAt,
                    null
                  )
                : row
            ),
          };
        });

        setHighlightedIds((current) => [...new Set([...current, report.locationId])]);
        window.setTimeout(() => {
          setHighlightedIds((current) => current.filter((id) => id !== report.locationId));
        }, 1800);
      },
    });

    return () => {
      socket.close();
    };
  }, [autoRefresh, enabled]);

  const refreshWorkspace = async (): Promise<void> => {
    await Promise.all([loadLocations(), loadSchedules(), onWorkspaceRefresh()]);
  };

  const runSingleToggle = useCallback(async (row: AdminLocationRow, powerStatus: boolean): Promise<void> => {
    if (!enabled) {
      return;
    }

    setMutatingLocationId(row.locationId);

    try {
      const report = await submitPowerReport({
        locationId: row.locationId,
        powerStatus,
      });

      setResponse((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          items: current.items.map((item) =>
            item.locationId === row.locationId
              ? applyPowerStateToLocationRow(
                  item,
                  report.powerStatus,
                  report.reportedBy ?? null,
                  report.reportedAt,
                  report.note ?? null
                )
              : item
          ),
        };
      });

      setHighlightedIds((current) => [...new Set([...current, row.locationId])]);
      showSuccess(`${row.name} is now ${powerStatus ? 'available' : 'unavailable'}.`, {
        title: 'Power updated',
        dedupeKey: `admin-power-toggle-${row.locationId}-${powerStatus}`,
      });

      await onWorkspaceRefresh();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Power update failed',
        dedupeKey: `admin-power-toggle-error-${row.locationId}`,
      });
    } finally {
      setMutatingLocationId(null);
      window.setTimeout(() => {
        setHighlightedIds((current) => current.filter((id) => id !== row.locationId));
      }, 1800);
    }
  }, [enabled, onWorkspaceRefresh, showError, showSuccess]);

  const runBulkAction = async (action: BulkPowerAction): Promise<void> => {
    if (!enabled || selectedRows.length === 0) {
      return;
    }

    setRunningBulkAction(action);

    try {
      const result = await submitBulkPowerReport({
        locationIds: selectedRows.map((row) => row.locationId),
        powerStatus: action === 'turn_on',
      });

      showSuccess(`${bulkActionLabel(action)} applied to ${result.affectedCount} location(s).`, {
        title: 'Bulk power update',
        dedupeKey: `admin-power-bulk-${action}-${result.reportedAt}`,
      });
      await refreshWorkspace();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Bulk action failed',
        dedupeKey: `admin-power-bulk-error-${action}`,
      });
    } finally {
      setRunningBulkAction(null);
    }
  };

  const runLockAction = async (locked: boolean, rows = selectedRows): Promise<void> => {
    if (!enabled || rows.length === 0) {
      return;
    }

    setRunningLockAction(locked);

    try {
      const result = await updatePowerLocationLockRequest({
        locationIds: rows.map((row) => row.locationId),
        locked,
      });

      showSuccess(
        `${locked ? 'Locked' : 'Unlocked'} public power updates for ${result.affectedCount} location(s).`,
        {
          title: locked ? 'Power updates locked' : 'Power updates unlocked',
          dedupeKey: `admin-power-lock-${locked}-${result.affectedCount}`,
        }
      );
      await refreshWorkspace();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Power lock failed',
        dedupeKey: `admin-power-lock-error-${locked}`,
      });
    } finally {
      setRunningLockAction(null);
    }
  };

  const handleSaveFilter = (): void => {
    const name = saveViewName.trim();
    if (!name) {
      return;
    }

    onSaveFilter('power', name, {
      search: debouncedSearch.trim(),
      status: statusFilter,
      ...toSortQuery(sorting),
    });

    showSuccess(`Saved "${name.trim()}" for Power Control.`, {
      title: 'Saved filter',
      dedupeKey: `power-saved-filter-${name.trim()}`,
    });
    setSaveViewOpen(false);
    setSaveViewName('');
  };

  const applySavedFilter = (filterId: string): void => {
    if (!filterId) {
      return;
    }

    const filter = powerSavedFilters.find((entry) => entry.id === filterId);
    if (!filter) {
      return;
    }

    const query = filter.query ?? {};
    setSearchQuery(typeof query.search === 'string' ? query.search : '');
    setStatusFilter(
      query.status === 'available' || query.status === 'unavailable' || query.status === 'no_report'
        ? query.status
        : ''
    );
    setSorting(toSortingState(query));
    setPageIndex(0);
  };

  const createSchedule = async (): Promise<void> => {
    if (!enabled || selectedRows.length === 0) {
      return;
    }

    setSavingSchedule(true);

    try {
      const timezone = displayTimezone;
      const scheduledFor = parseDateTimeInputValueToUtcIso(scheduleDraft.scheduledFor, timezone);

      await createPowerScheduleRequest({
        locationIds: selectedRows.map((row) => row.locationId),
        action: scheduleDraft.action,
        recurrence: scheduleDraft.recurrence,
        scheduledFor,
        timezone,
        note: scheduleDraft.note.trim() || undefined,
      });

      showSuccess(
        `${bulkActionLabel(scheduleDraft.action)} scheduled for ${selectedRows.length} location(s) as ${scheduleRecurrenceOptions.find((option) => option.value === scheduleDraft.recurrence)?.label?.toLowerCase() ?? 'one time'}.`,
        {
          title: 'Schedule created',
          dedupeKey: `admin-power-schedule-${scheduleDraft.scheduledFor}-${scheduleDraft.action}`,
        }
      );

      setScheduleDraft(buildDefaultScheduleDraft());

      await refreshWorkspace();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Schedule failed',
        dedupeKey: `admin-power-schedule-error-${scheduleDraft.action}`,
      });
    } finally {
      setSavingSchedule(false);
    }
  };

  const cancelSchedule = async (schedule: PowerScheduleRecord): Promise<void> => {
    try {
      await cancelPowerScheduleRequest(schedule.id);
      showSuccess('Scheduled power update cancelled.', {
        title: 'Schedule cancelled',
        dedupeKey: `admin-power-schedule-cancel-${schedule.id}`,
      });
      await refreshWorkspace();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Cancel failed',
        dedupeKey: `admin-power-schedule-cancel-error-${schedule.id}`,
      });
    }
  };

  const columns = useMemo<ColumnDef<AdminLocationRow>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllPageRowsSelected()}
            ref={(input) => {
              if (input) {
                input.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
              }
            }}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
            aria-label="Select all power rows"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            aria-label={`Select ${row.original.name}`}
          />
        ),
        enableSorting: false,
      },
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Location',
        cell: ({ row }) => (
          <div className="min-w-[220px]">
            <p className="font-semibold text-slate-950">{row.original.name}</p>
            <p className="mt-1 text-xs text-slate-500">{row.original.buildingId}</p>
          </div>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div className="flex flex-col gap-2">
            <LocationStatusBadge
              status={row.original.status}
              label={row.original.statusLabel}
              pulse={highlightedIds.includes(row.original.locationId)}
            />
            <AdminStatusBadge tone={row.original.powerUpdateLocked ? 'warning' : 'default'}>
              {row.original.powerUpdateLocked ? 'Public locked' : 'Public open'}
            </AdminStatusBadge>
          </div>
        ),
      },
      {
        id: 'lastUpdated',
        accessorKey: 'lastUpdated',
        header: 'Last Updated',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-slate-900">{formatAdminRelativeTime(row.original.lastUpdated)}</p>
            <p className="mt-1 text-xs text-slate-500">{formatAdminDateTime(row.original.lastUpdated)}</p>
          </div>
        ),
      },
      {
        id: 'operator',
        accessorKey: 'operator',
        header: 'Operator',
        cell: ({ row }) => <span>{row.original.operator ?? 'No operator'}</span>,
      },
      {
        id: 'toggle',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => {
          const nextPowerStatus = row.original.status !== 'available';
          const isBusy = mutatingLocationId === row.original.locationId;
          const isLockBusy = runningLockAction !== null;

          return (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void runSingleToggle(row.original, nextPowerStatus);
                }}
                disabled={isBusy || !enabled}
                className={cx(
                  'rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-60',
                  nextPowerStatus
                    ? 'border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50'
                    : 'border border-rose-200 bg-white text-rose-700 hover:bg-rose-50'
                )}
              >
                {isBusy ? 'Updating...' : nextPowerStatus ? 'Turn ON' : 'Turn OFF'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void runLockAction(!row.original.powerUpdateLocked, [row.original]);
                }}
                disabled={isLockBusy || !enabled}
                className={cx(
                  'rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-60',
                  row.original.powerUpdateLocked
                    ? 'border-amber-200 bg-white text-amber-800 hover:bg-amber-50'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-950'
                )}
              >
                {isLockBusy
                  ? 'Saving...'
                  : row.original.powerUpdateLocked
                    ? 'Unlock public'
                    : 'Lock public'}
              </button>
            </div>
          );
        },
      },
    ],
    [enabled, highlightedIds, mutatingLocationId, runLockAction, runSingleToggle, runningLockAction]
  );

  if (!enabled) {
    return (
      <AdminSectionCard
        label="Power control"
        title="Live power control"
      >
        <AdminEmptyState
          title="Sign in to control power state"
          message="Sign in to use live toggles and scheduling."
        />
      </AdminSectionCard>
    );
  }

  return (
    <div className="space-y-6">
      {selectedRows.length > 0 ? (
        <BulkActionBar count={selectedRows.length}>
          <button
            type="button"
            onClick={() => {
              void runBulkAction('turn_on');
            }}
            disabled={runningBulkAction !== null}
            className="rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningBulkAction === 'turn_on' ? 'Working...' : 'Turn ON power'}
          </button>
          <button
            type="button"
            onClick={() => {
              void runBulkAction('turn_off');
            }}
            disabled={runningBulkAction !== null}
            className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningBulkAction === 'turn_off' ? 'Working...' : 'Turn OFF power'}
          </button>
          <button
            type="button"
            onClick={() => {
              void runBulkAction('mark_unavailable');
            }}
            disabled={runningBulkAction !== null}
            className="rounded-full border border-amber-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-800 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningBulkAction === 'mark_unavailable' ? 'Working...' : 'Mark unavailable'}
          </button>
          <button
            type="button"
            onClick={() => {
              void runLockAction(true);
            }}
            disabled={runningLockAction !== null}
            className="rounded-full border border-amber-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-800 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningLockAction === true ? 'Working...' : 'Lock public updates'}
          </button>
          <button
            type="button"
            onClick={() => {
              void runLockAction(false);
            }}
            disabled={runningLockAction !== null}
            className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningLockAction === false ? 'Working...' : 'Unlock public updates'}
          </button>
          <button
            type="button"
            onClick={() =>
              setScheduleDraft((current) => ({
                ...current,
                open: true,
              }))
            }
            className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
          >
            Schedule update
          </button>
        </BulkActionBar>
      ) : null}

      <AdminSectionCard>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <LiveIndicator
                active={socketConnected}
                label={
                  socketConnected
                    ? lastSignalAt
                      ? `Live • ${formatAdminRelativeTime(lastSignalAt)}`
                      : 'Live connected'
                    : 'Live disconnected'
                }
              />
              <AdminStatusBadge tone="info">{response?.summary.totalLocations ?? 0} tracked</AdminStatusBadge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setScheduleDraft((current) => ({
                    ...current,
                    open: true,
                  }))
                }
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
              >
                Schedule
              </button>
              <button
                type="button"
                onClick={() => {
                  void refreshWorkspace();
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

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_220px_220px]">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search locations for live power control"
            />
            <FilterDropdown
              label="Status"
              value={statusFilter}
              options={statusOptions}
              onChange={(value) => setStatusFilter(value as AdminLocationStatus | '')}
            />
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Saved views
              </span>
              <select
                defaultValue=""
                onChange={(event) => {
                  applySavedFilter(event.target.value);
                  event.target.value = '';
                }}
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              >
                <option value="">Apply saved view</option>
                {powerSavedFilters.map((filter) => (
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
            sorting={sorting}
            onSortingChange={setSorting}
            onPageIndexChange={setPageIndex}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPageIndex(0);
            }}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            getRowId={(row) => row.locationId}
            loading={loading}
            dense={dense}
            emptyState={
              <AdminEmptyState
                title="No matching locations"
                message="Adjust the search or filter to target a different set of locations."
              />
            }
          />
        </div>
      </AdminSectionCard>

      <AdminSectionCard label="Scheduling" title="Scheduled updates">
        {scheduleLoading && !schedules ? (
          <PanelSkeleton
            title="Loading scheduled updates"
            subtitle="Keeping the schedule section stable while pending power updates sync in."
            lines={3}
          />
        ) : !schedules || schedules.items.length === 0 ? (
          <AdminEmptyState
            title="No schedules yet"
            message="Select locations above, then create a one-time or recurring schedule for a future power update."
          />
        ) : (
          <div className="space-y-3">
            {schedules.items.map((schedule) => (
              <article
                key={schedule.id}
                className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminStatusBadge tone={scheduleStatusTone(schedule.status)}>
                      {schedule.status}
                    </AdminStatusBadge>
                    <AdminStatusBadge>{schedule.locationIds.length} location(s)</AdminStatusBadge>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-slate-950">{schedule.actionLabel}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {schedule.recurrence === 'once' ? 'Scheduled for' : 'Next run'} {formatAdminDateTime(schedule.scheduledFor)} ({schedule.timezone})
                  </p>
                  <p className="mt-1 text-sm text-slate-500">Repeats: {schedule.recurrenceLabel}</p>
                  {schedule.executedAt ? (
                    <p className="mt-1 text-xs text-slate-500">Last run {formatAdminDateTime(schedule.executedAt)}</p>
                  ) : null}
                  {schedule.note ? <p className="mt-2 text-sm text-slate-500">{schedule.note}</p> : null}
                </div>
                {schedule.status === 'scheduled' ? (
                  <button
                    type="button"
                    onClick={() => {
                      void cancelSchedule(schedule);
                    }}
                    className="rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
                  >
                    Cancel schedule
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </AdminSectionCard>

      <SidePanelEditor
        open={scheduleDraft.open}
        title="Schedule mass power update"
        description={`${selectedRows.length} selected`}
        onClose={() =>
          setScheduleDraft(buildDefaultScheduleDraft())
        }
      >
        {selectedRows.length === 0 ? (
          <AdminEmptyState
            title="Select locations first"
            message="Choose one or more rows in the Power Control table, then open the scheduling panel again."
          />
        ) : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
              Scheduling <span className="font-semibold text-slate-900">{selectedRows.length}</span> location(s) in{' '}
              <span className="font-semibold text-slate-900">{displayTimezone}</span>
              . Recurring schedules automatically queue the next run after each successful update.
            </div>

            <FilterDropdown
              label="Scheduled action"
              value={scheduleDraft.action}
              options={[
                { label: 'Turn ON power', value: 'turn_on' },
                { label: 'Turn OFF power', value: 'turn_off' },
                { label: 'Mark unavailable', value: 'mark_unavailable' },
              ]}
              onChange={(value) =>
                setScheduleDraft((current) => ({
                  ...current,
                  action: value as BulkPowerAction,
                }))
              }
            />

            <FilterDropdown
              label="Repeat"
              value={scheduleDraft.recurrence}
              options={scheduleRecurrenceOptions}
              onChange={(value) =>
                setScheduleDraft((current) => ({
                  ...current,
                  recurrence: value as PowerScheduleRecurrence,
                }))
              }
            />

            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                {scheduleDraft.recurrence === 'once' ? 'Scheduled time' : 'First run time'}
              </span>
              <input
                type="datetime-local"
                value={scheduleDraft.scheduledFor}
                onChange={(event) =>
                  setScheduleDraft((current) => ({
                    ...current,
                    scheduledFor: event.target.value,
                  }))
                }
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Note
              </span>
              <textarea
                rows={4}
                value={scheduleDraft.note}
                onChange={(event) =>
                  setScheduleDraft((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                placeholder="Optional note for this scheduled update"
              />
            </label>

            <button
              type="button"
              onClick={() => {
                void createSchedule();
              }}
              disabled={savingSchedule}
              className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {savingSchedule ? 'Scheduling...' : `Schedule for ${selectedRows.length} location(s)`}
            </button>
          </div>
        )}
      </SidePanelEditor>
      <TextEntryModal
        open={saveViewOpen}
        title="Save power control view"
        description="Save the current power filters and sorting so this live-control view is easy to reopen."
        label="View name"
        value={saveViewName}
        placeholder="For example: No report locations"
        confirmLabel="Save view"
        confirmDisabled={!saveViewName.trim()}
        onCancel={() => {
          setSaveViewOpen(false);
          setSaveViewName('');
        }}
        onChange={setSaveViewName}
        onConfirm={handleSaveFilter}
      />
    </div>
  );
}
