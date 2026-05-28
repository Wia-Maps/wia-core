import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import { useToast } from '../../context/ToastContext';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import {
  bulkDeleteAdminMapDatasetFeatures,
  deleteAdminMapFeature,
  type MapFeatureCollection,
} from '../../services/mapDatasets';
import {
  fetchAdminFellowshipBrands,
  fetchAdminLocation,
  fetchAdminLocations,
  getAdminApiError,
  removeAdminFellowshipBrandLogo,
  submitBulkPowerReport,
  submitPowerReport,
  uploadAdminFellowshipBrandLogo,
  updateAdminLocation,
  type AdminLocationDetailRecord,
  type FellowshipBrandUploadInput,
  type AdminLocationRow,
  type AdminLocationStatus,
  type BulkPowerAction,
  type LocationTableQuery,
} from '../../services/adminApi';
import { writeCachedMapDataset } from '../../services/mapDatasetCache';
import { publishMapDatasetUpdated } from '../../services/mapDatasetEvents';
import { publishFellowshipBrandsUpdated } from '../../services/fellowshipBrandEvents';
import FellowshipBrandBadge from '../FellowshipBrandBadge';
import { PanelSkeleton } from '../LoadingPrimitives';
import {
  type FellowshipBrandRecord,
  normalizeFellowshipEntry,
  normalizeFellowshipCode,
  toTimeInputValue,
  type FellowshipServiceEntry,
  type FellowshipVenueEntry,
} from '../../core/fellowshipUtils';
import type { SavedFilterRecord } from '../../services/adminPreferences';
import {
  ActionMenu,
  BulkActionBar,
  ConfirmationModal,
  DataTable,
  FilterDropdown,
  SearchInput,
  SidePanelEditor,
  TextEntryModal,
} from './AdminOpsComponents';
import {
  ADMIN_LOCATION_FOCUS_EVENT,
  LocationStatusBadge,
  applyPowerStateToLocationRow,
  bulkActionLabel,
  exportLocationRowsCsv,
  formatAdminDateTime,
  formatAdminRelativeTime,
} from './adminPageUtils';
import { AdminEmptyState, AdminSectionCard, AdminStatusBadge, cx } from './AdminUi';

interface AdminLocationsPageProps {
  enabled: boolean;
  dense: boolean;
  defaultPageSize: number;
  autoRefresh: boolean;
  savedFilters: SavedFilterRecord[];
  onSaveFilter: (page: 'locations', name: string, query: Record<string, unknown>) => void;
  onWorkspaceRefresh: () => Promise<void>;
  onOpenDatasetAccessEditor: (featureId: string) => void;
}

type PanelMode = 'view' | 'edit';

interface LocationPanelState {
  open: boolean;
  locationId: string | null;
  mode: PanelMode;
}

interface BulkReportDraft {
  open: boolean;
  powerStatus: boolean;
  note: string;
}

interface ConfirmationState {
  open: boolean;
  action: BulkPowerAction | null;
  count: number;
}

interface DeleteConfirmationState {
  open: boolean;
  rows: AdminLocationRow[];
}

interface FellowshipLogoRemovalState {
  open: boolean;
  code: string;
  name: string;
}

const createEmptyFellowshipService = (): FellowshipServiceEntry => ({
  dayLabel: '',
  timeLabel: '',
  roomLabel: '',
  infoLabel: '',
});

const createEmptyFellowship = (): FellowshipVenueEntry => ({
  code: '',
  name: '',
  contact: '',
  services: [createEmptyFellowshipService()],
});

const clonePanelMetadata = (
  metadata: AdminLocationDetailRecord['metadata']
): AdminLocationDetailRecord['metadata'] => ({
  ...metadata,
  powerUpdateLocked: Boolean(metadata.powerUpdateLocked),
  fellowships: (metadata.fellowships ?? []).map((entry) => ({
    ...entry,
    contact: entry.contact ?? '',
    services: (entry.services ?? []).map((service) => ({
      ...service,
      roomLabel: service.roomLabel ?? '',
      infoLabel: service.infoLabel ?? '',
    })),
  })),
});

const statusOptions: Array<{ label: string; value: AdminLocationStatus | '' }> = [
  { label: 'All statuses', value: '' },
  { label: 'Available', value: 'available' },
  { label: 'Unavailable', value: 'unavailable' },
  { label: 'No report', value: 'no_report' },
];

const fellowshipDayOptions = [
  { label: 'Choose day', value: '' },
  { label: 'Monday', value: 'Monday' },
  { label: 'Tuesday', value: 'Tuesday' },
  { label: 'Wednesday', value: 'Wednesday' },
  { label: 'Thursday', value: 'Thursday' },
  { label: 'Friday', value: 'Friday' },
  { label: 'Saturday', value: 'Saturday' },
  { label: 'Sunday', value: 'Sunday' },
];

const toSortQuery = (sorting: SortingState): Pick<LocationTableQuery, 'sortBy' | 'sortDir'> => {
  const active = sorting[0];

  if (!active) {
    return {
      sortBy: 'name',
      sortDir: 'asc',
    };
  }

  const sortByMap: Record<string, LocationTableQuery['sortBy']> = {
    name: 'name',
    buildingId: 'buildingId',
    category: 'category',
    status: 'status',
    lastUpdated: 'lastUpdated',
    operator: 'operator',
  };

  return {
    sortBy: sortByMap[active.id] ?? 'name',
    sortDir: active.desc ? 'desc' : 'asc',
  };
};

const toSortingState = (query: Record<string, unknown>): SortingState => {
  const sortBy = typeof query.sortBy === 'string' ? query.sortBy : 'name';
  const sortDir = query.sortDir === 'desc' ? 'desc' : 'asc';

  return [
    {
      id: sortBy,
      desc: sortDir === 'desc',
    },
  ];
};

const baseButtonClassName =
  'rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-60';

const ALLOWED_FELLOWSHIP_LOGO_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);

const MAX_FELLOWSHIP_LOGO_BYTES = 2_000_000;

const formatUploadSizeLabel = (byteCount: number): string => {
  if (byteCount >= 1_000_000) {
    return `${(byteCount / 1_000_000).toFixed(1)} MB`;
  }

  if (byteCount >= 1000) {
    return `${Math.round(byteCount / 1000)} KB`;
  }

  return `${byteCount} bytes`;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Selected file could not be read.'));
    };

    reader.onerror = () => {
      reject(new Error('Selected file could not be read.'));
    };

    reader.readAsDataURL(file);
  });
};

const sortFellowshipBrands = (brands: FellowshipBrandRecord[]): FellowshipBrandRecord[] => {
  return [...brands].sort((left, right) => left.code.localeCompare(right.code));
};

const upsertFellowshipBrandRecord = (
  brands: FellowshipBrandRecord[],
  nextBrand: FellowshipBrandRecord
): FellowshipBrandRecord[] => {
  const normalizedCode = normalizeFellowshipCode(nextBrand.code);

  return sortFellowshipBrands([
    ...brands.filter((brand) => normalizeFellowshipCode(brand.code) !== normalizedCode),
    {
      ...nextBrand,
      code: normalizedCode,
    },
  ]);
};

export default function AdminLocationsPage({
  enabled,
  dense,
  defaultPageSize,
  autoRefresh,
  savedFilters,
  onSaveFilter,
  onWorkspaceRefresh,
  onOpenDatasetAccessEditor,
}: AdminLocationsPageProps): JSX.Element {
  const { showError, showSuccess } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AdminLocationStatus | ''>('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [response, setResponse] = useState<Awaited<ReturnType<typeof fetchAdminLocations>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [confirmState, setConfirmState] = useState<ConfirmationState>({
    open: false,
    action: null,
    count: 0,
  });
  const [deleteConfirmState, setDeleteConfirmState] = useState<DeleteConfirmationState>({
    open: false,
    rows: [],
  });
  const [bulkReportDraft, setBulkReportDraft] = useState<BulkReportDraft>({
    open: false,
    powerStatus: true,
    note: '',
  });
  const [runningBulkAction, setRunningBulkAction] = useState(false);
  const [runningDeleteAction, setRunningDeleteAction] = useState(false);
  const [panelState, setPanelState] = useState<LocationPanelState>({
    open: false,
    locationId: null,
    mode: 'view',
  });
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelDetail, setPanelDetail] = useState<AdminLocationDetailRecord | null>(null);
  const [panelForm, setPanelForm] = useState<AdminLocationDetailRecord['metadata']>({
    name: '',
    type: '',
    shortCode: '',
    campusId: '',
    powerUpdateLocked: false,
    fellowships: [],
  });
  const [savingPanel, setSavingPanel] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [fellowshipBrands, setFellowshipBrands] = useState<FellowshipBrandRecord[]>([]);
  const [runningFellowshipBrandCode, setRunningFellowshipBrandCode] = useState('');
  const [fellowshipLogoRemovalState, setFellowshipLogoRemovalState] = useState<FellowshipLogoRemovalState>({
    open: false,
    code: '',
    name: '',
  });
  const debouncedSearch = useDebouncedValue(searchQuery, 500);

  const locationSavedFilters = useMemo(() => {
    return savedFilters.filter((filter) => filter.page === 'locations');
  }, [savedFilters]);

  const selectedRows = useMemo(() => {
    const selectedIds = new Set(
      Object.entries(rowSelection)
        .filter(([, selected]) => Boolean(selected))
        .map(([id]) => id)
    );

    return (response?.items ?? []).filter((row) => selectedIds.has(row.locationId));
  }, [response, rowSelection]);

  const fellowshipBrandLookup = useMemo(() => {
    return fellowshipBrands.reduce<Record<string, FellowshipBrandRecord>>((accumulator, brand) => {
      const code = normalizeFellowshipCode(brand.code);

      if (!code) {
        return accumulator;
      }

      accumulator[code] = {
        ...brand,
        code,
      };
      return accumulator;
    }, {});
  }, [fellowshipBrands]);

  const loadFellowshipBrands = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}): Promise<void> => {
      if (!enabled) {
        setFellowshipBrands([]);
        return;
      }

      try {
        const brands = await fetchAdminFellowshipBrands();
        setFellowshipBrands(sortFellowshipBrands(brands));
      } catch (error) {
        if (!silent) {
          showError(getAdminApiError(error), {
            title: 'Fellowship badges',
            dedupeKey: 'admin-fellowship-brands',
          });
        }
      }
    },
    [enabled, showError]
  );

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
        category: categoryFilter,
        ...toSortQuery(sorting),
      });

      setResponse(nextResponse);
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Locations',
        dedupeKey: 'admin-locations-table',
      });
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, debouncedSearch, enabled, pageIndex, pageSize, showError, sorting, statusFilter]);

  useEffect(() => {
    void loadLocations();
  }, [loadLocations]);

  useEffect(() => {
    void loadFellowshipBrands({ silent: true });
  }, [loadFellowshipBrands]);

  useEffect(() => {
    if (!enabled || !autoRefresh) {
      return;
    }

    const handle = window.setInterval(() => {
      void loadLocations();
    }, 60000);

    return () => {
      window.clearInterval(handle);
    };
  }, [autoRefresh, enabled, loadLocations]);

  useEffect(() => {
    setPageIndex(0);
  }, [categoryFilter, debouncedSearch, statusFilter]);

  useEffect(() => {
    setRowSelection({});
  }, [pageIndex, pageSize, categoryFilter, debouncedSearch, statusFilter]);

  useEffect(() => {
    if (!panelState.open || !panelState.locationId || !enabled) {
      return;
    }

    let cancelled = false;

    const loadDetail = async (): Promise<void> => {
      setPanelLoading(true);

      try {
        const detail = await fetchAdminLocation(panelState.locationId as string);

        if (cancelled) {
          return;
        }

        setPanelDetail(detail);
        setPanelForm(clonePanelMetadata(detail.metadata));
      } catch (error) {
        if (!cancelled) {
          showError(getAdminApiError(error), {
            title: 'Location detail',
            dedupeKey: `admin-location-detail-${panelState.locationId}`,
          });
        }
      } finally {
        if (!cancelled) {
          setPanelLoading(false);
        }
      }
    };

    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [enabled, panelState.locationId, panelState.open, showError]);

  useEffect(() => {
    const handleFocusLocation = (event: Event): void => {
      const detail = (event as CustomEvent<{ locationId: string }>).detail;
      if (!detail?.locationId) {
        return;
      }

      setPanelState({
        open: true,
        locationId: detail.locationId,
        mode: enabled ? 'edit' : 'view',
      });
    };

    window.addEventListener(ADMIN_LOCATION_FOCUS_EVENT, handleFocusLocation);

    return () => {
      window.removeEventListener(ADMIN_LOCATION_FOCUS_EVENT, handleFocusLocation);
    };
  }, [enabled]);

  const handleOpenPanel = useCallback((row: AdminLocationRow, mode: PanelMode): void => {
    setPanelDetail(null);
    setPanelState({
      open: true,
      locationId: row.locationId,
      mode,
    });
  }, []);

  const closePanel = (): void => {
    setPanelState({
      open: false,
      locationId: null,
      mode: 'view',
    });
    setPanelDetail(null);
  };

  const refreshAfterMutation = useCallback(async (): Promise<void> => {
    await Promise.all([loadLocations(), onWorkspaceRefresh()]);
  }, [loadLocations, onWorkspaceRefresh]);

  const runSinglePowerAction = useCallback(async (row: AdminLocationRow, powerStatus: boolean): Promise<void> => {
    if (!enabled) {
      return;
    }

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
              ? applyPowerStateToLocationRow(item, report.powerStatus, report.reportedBy ?? null, report.reportedAt, report.note ?? null)
              : item
          ),
        };
      });

      showSuccess(`${row.name} is now ${powerStatus ? 'available' : 'unavailable'}.`, {
        title: 'Power updated',
        dedupeKey: `admin-location-toggle-${row.locationId}-${powerStatus}`,
      });
      await onWorkspaceRefresh();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Power update failed',
        dedupeKey: `admin-location-toggle-error-${row.locationId}`,
      });
    }
  }, [enabled, onWorkspaceRefresh, showError, showSuccess]);

  const executeBulkAction = async (action: BulkPowerAction, note?: string): Promise<void> => {
    if (!enabled || selectedRows.length === 0) {
      return;
    }

    setRunningBulkAction(true);

    try {
      const result = await submitBulkPowerReport({
        locationIds: selectedRows.map((row) => row.locationId),
        powerStatus: action === 'turn_on',
        note,
      });

      showSuccess(`${bulkActionLabel(action)} applied to ${result.affectedCount} location(s).`, {
        title: 'Bulk power update',
        dedupeKey: `admin-location-bulk-${action}-${result.reportedAt}`,
      });

      setConfirmState({
        open: false,
        action: null,
        count: 0,
      });
      setBulkReportDraft({
        open: false,
        powerStatus: true,
        note: '',
      });

      await refreshAfterMutation();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Bulk action failed',
        dedupeKey: `admin-location-bulk-error-${action}`,
      });
    } finally {
      setRunningBulkAction(false);
    }
  };

  const handleSavePanel = async (): Promise<void> => {
    if (!enabled || !panelState.locationId) {
      return;
    }

    setSavingPanel(true);

    try {
      const payload: AdminLocationDetailRecord['metadata'] = {
        ...panelForm,
        fellowships: panelForm.fellowships
          .map((entry) => {
            const normalizedCode = normalizeFellowshipCode(entry.code);
            const fellowshipBrand = normalizedCode ? fellowshipBrandLookup[normalizedCode] ?? null : null;

            return normalizeFellowshipEntry({
              ...entry,
              code: normalizedCode,
              name: entry.name?.trim() || fellowshipBrand?.name || '',
              contact: entry.contact?.trim() || fellowshipBrand?.contact || '',
              services: entry.services,
            });
          })
          .filter((entry): entry is FellowshipVenueEntry => Boolean(entry)),
      };

      const result = await updateAdminLocation(panelState.locationId, payload);
      await writeCachedMapDataset(result.mutation.dataset);
      publishMapDatasetUpdated(result.mutation.dataset);

      showSuccess(`${result.location.name} metadata saved.`, {
        title: 'Location updated',
        dedupeKey: `admin-location-save-${result.location.locationId}`,
      });

      setPanelDetail({
        location: result.location,
        metadata: clonePanelMetadata(payload),
      });

      setPanelForm(clonePanelMetadata(payload));

      await refreshAfterMutation();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Save failed',
        dedupeKey: `admin-location-save-error-${panelState.locationId}`,
      });
    } finally {
      setSavingPanel(false);
    }
  };

  const handleDeleteLocations = useCallback(async (rows: AdminLocationRow[]): Promise<void> => {
    if (!enabled || rows.length === 0) {
      return;
    }

    setRunningDeleteAction(true);

    try {
      const result = rows.length === 1
        ? await deleteAdminMapFeature<MapFeatureCollection>('locations', rows[0].featureId)
        : await bulkDeleteAdminMapDatasetFeatures<MapFeatureCollection>('locations', rows.map((row) => row.featureId));
      await writeCachedMapDataset(result.dataset);
      publishMapDatasetUpdated(result.dataset);

      showSuccess(rows.length === 1 ? `${rows[0].name} deleted from the live dataset.` : `${rows.length} locations deleted from the live dataset.`, {
        title: rows.length === 1 ? 'Location deleted' : 'Locations deleted',
        dedupeKey: rows.length === 1 ? `admin-location-delete-${rows[0].locationId}` : `admin-location-delete-bulk-${rows.length}`,
      });

      setDeleteConfirmState({
        open: false,
        rows: [],
      });

      if (panelState.locationId && rows.some((row) => row.locationId === panelState.locationId)) {
        closePanel();
      }

      setRowSelection({});
      await refreshAfterMutation();
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Delete failed',
        dedupeKey: rows.length === 1 ? `admin-location-delete-error-${rows[0].locationId}` : `admin-location-delete-bulk-error-${rows.length}`,
      });
    } finally {
      setRunningDeleteAction(false);
    }
  }, [enabled, panelState.locationId, refreshAfterMutation, showError, showSuccess]);

  const handleApplySavedFilter = (filterId: string): void => {
    if (!filterId) {
      return;
    }

    const filter = locationSavedFilters.find((entry) => entry.id === filterId);
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
    setCategoryFilter(typeof query.category === 'string' ? query.category : '');
    setSorting(toSortingState(query));
    setPageIndex(0);
  };

  const handleSaveCurrentView = (): void => {
    const name = saveViewName.trim();
    if (!name) {
      return;
    }

    onSaveFilter('locations', name, {
      search: debouncedSearch.trim(),
      status: statusFilter,
      category: categoryFilter,
      ...toSortQuery(sorting),
    });

    showSuccess(`Saved "${name.trim()}" for the Locations page.`, {
      title: 'Saved filter',
      dedupeKey: `locations-saved-filter-${name.trim()}`,
    });
    setSaveViewOpen(false);
    setSaveViewName('');
  };

  const handleFellowshipLogoSelected = useCallback(
    async (entryIndex: number, file: File | null): Promise<void> => {
      if (!file) {
        return;
      }

      const entry = panelForm.fellowships[entryIndex];
      const normalizedCode = normalizeFellowshipCode(entry?.code);

      if (!normalizedCode) {
        showError('Choose a fellowship code before uploading a logo.', {
          title: 'Fellowship badge',
          dedupeKey: 'fellowship-badge-code-required',
        });
        return;
      }

      if (!ALLOWED_FELLOWSHIP_LOGO_TYPES.has(file.type)) {
        showError('Use a PNG, JPEG, WEBP, or SVG image for the fellowship badge.', {
          title: 'Unsupported file',
          dedupeKey: `fellowship-badge-type-${normalizedCode}`,
        });
        return;
      }

      if (file.size > MAX_FELLOWSHIP_LOGO_BYTES) {
        showError(
          `Badge images must be smaller than ${formatUploadSizeLabel(MAX_FELLOWSHIP_LOGO_BYTES)}.`,
          {
            title: 'File too large',
            dedupeKey: `fellowship-badge-size-${normalizedCode}`,
          }
        );
        return;
      }

      setRunningFellowshipBrandCode(normalizedCode);

      try {
        const fileDataUrl = await readFileAsDataUrl(file);
        const payload: FellowshipBrandUploadInput = {
          name: entry?.name?.trim() || undefined,
          contact: entry?.contact?.trim() || undefined,
          fileDataUrl,
        };
        const nextBrand = await uploadAdminFellowshipBrandLogo(normalizedCode, payload);

        setFellowshipBrands((current) => upsertFellowshipBrandRecord(current, nextBrand));
        publishFellowshipBrandsUpdated();

        showSuccess(`${normalizedCode} badge updated for every venue using that code.`, {
          title: 'Fellowship badge saved',
          dedupeKey: `fellowship-badge-upload-${normalizedCode}`,
        });
      } catch (error) {
        showError(getAdminApiError(error), {
          title: 'Badge upload failed',
          dedupeKey: `fellowship-badge-upload-error-${normalizedCode}`,
        });
      } finally {
        setRunningFellowshipBrandCode('');
      }
    },
    [panelForm.fellowships, showError, showSuccess]
  );

  const handleRemoveFellowshipLogo = useCallback(async (): Promise<void> => {
    const normalizedCode = normalizeFellowshipCode(fellowshipLogoRemovalState.code);

    if (!normalizedCode) {
      return;
    }

    setRunningFellowshipBrandCode(normalizedCode);

    try {
      const nextBrand = await removeAdminFellowshipBrandLogo(normalizedCode);

      setFellowshipBrands((current) => upsertFellowshipBrandRecord(current, nextBrand));
      publishFellowshipBrandsUpdated();
      setFellowshipLogoRemovalState({
        open: false,
        code: '',
        name: '',
      });

      showSuccess(`${normalizedCode} now falls back to the text badge on the map.`, {
        title: 'Fellowship badge removed',
        dedupeKey: `fellowship-badge-remove-${normalizedCode}`,
      });
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Badge removal failed',
        dedupeKey: `fellowship-badge-remove-error-${normalizedCode}`,
      });
    } finally {
      setRunningFellowshipBrandCode('');
    }
  }, [fellowshipLogoRemovalState.code, showError, showSuccess]);

  const columns = useMemo<ColumnDef<AdminLocationRow>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all rows"
            checked={table.getIsAllPageRowsSelected()}
            ref={(input) => {
              if (input) {
                input.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
              }
            }}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.name}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'name',
        id: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-[220px]">
            <p className="font-semibold text-slate-950">{row.original.name}</p>
            <p className="mt-1 text-xs text-slate-500">{row.original.locationId}</p>
          </div>
        ),
      },
      {
        accessorKey: 'buildingId',
        id: 'buildingId',
        header: 'Building ID',
        cell: ({ row }) => <span>{row.original.buildingId}</span>,
      },
      {
        accessorKey: 'category',
        id: 'category',
        header: 'Category',
        cell: ({ row }) => <span>{row.original.category}</span>,
      },
      {
        accessorKey: 'status',
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <LocationStatusBadge status={row.original.status} label={row.original.statusLabel} />
        ),
      },
      {
        accessorKey: 'lastUpdated',
        id: 'lastUpdated',
        header: 'Last Updated',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-slate-900">{formatAdminRelativeTime(row.original.lastUpdated)}</p>
            <p className="mt-1 text-xs text-slate-500">{formatAdminDateTime(row.original.lastUpdated)}</p>
          </div>
        ),
      },
      {
        accessorKey: 'operator',
        id: 'operator',
        header: 'Operator',
        cell: ({ row }) => <span>{row.original.operator ?? 'No operator'}</span>,
      },
      {
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => (
          <ActionMenu
            items={[
              {
                label: 'View',
                onSelect: () => handleOpenPanel(row.original, 'view'),
              },
              {
                label: enabled ? 'Edit' : 'Inspect',
                onSelect: () => handleOpenPanel(row.original, enabled ? 'edit' : 'view'),
              },
              {
                label: row.original.status === 'available' ? 'Turn OFF power' : 'Turn ON power',
                onSelect: () => {
                  void runSinglePowerAction(row.original, row.original.status !== 'available');
                },
              },
              {
                label: 'Delete',
                onSelect: () => {
                  setDeleteConfirmState({
                    open: true,
                    rows: [row.original],
                  });
                },
                tone: 'danger',
              },
            ]}
          />
        ),
      },
    ],
    [enabled, handleOpenPanel, runSinglePowerAction]
  );

  if (!enabled) {
    return (
      <AdminSectionCard
        label="Locations"
        title="Location operations"
      >
        <AdminEmptyState
          title="Sign in to manage locations"
          message="Sign in to edit metadata and run bulk actions."
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
            onClick={() =>
              setConfirmState({ open: true, action: 'turn_on', count: selectedRows.length })
            }
            className={cx(baseButtonClassName, 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50')}
          >
            Turn ON power
          </button>
          <button
            type="button"
            onClick={() =>
              setConfirmState({ open: true, action: 'turn_off', count: selectedRows.length })
            }
            className={cx(baseButtonClassName, 'border-rose-200 bg-white text-rose-700 hover:bg-rose-50')}
          >
            Turn OFF power
          </button>
          <button
            type="button"
            onClick={() =>
              setDeleteConfirmState({
                open: true,
                rows: selectedRows,
              })
            }
            className={cx(baseButtonClassName, 'border-rose-200 bg-white text-rose-700 hover:bg-rose-50')}
          >
            Delete selected
          </button>
          <button
            type="button"
            onClick={() =>
              setBulkReportDraft({
                open: true,
                powerStatus: true,
                note: '',
              })
            }
            className={cx(baseButtonClassName, 'border-slate-300 bg-white text-slate-700 hover:border-slate-400')}
          >
            Add report
          </button>
          <button
            type="button"
            onClick={() => exportLocationRowsCsv(selectedRows)}
            className={cx(baseButtonClassName, 'border-slate-300 bg-white text-slate-700 hover:border-slate-400')}
          >
            Export
          </button>
        </BulkActionBar>
      ) : null}

      <AdminSectionCard>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <AdminStatusBadge>{response?.summary.totalLocations ?? 0} total</AdminStatusBadge>
              <AdminStatusBadge tone="success">{response?.summary.availableCount ?? 0} available</AdminStatusBadge>
              <AdminStatusBadge tone="danger">{response?.summary.unavailableCount ?? 0} unavailable</AdminStatusBadge>
              <AdminStatusBadge tone="warning">{response?.summary.noReportCount ?? 0} waiting</AdminStatusBadge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void refreshAfterMutation();
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

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(180px,0.6fr))]">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search by location name, building ID, short code, or category"
            />
            <FilterDropdown
              label="Status"
              value={statusFilter}
              options={statusOptions}
              onChange={(value) => setStatusFilter(value as AdminLocationStatus | '')}
            />
            <FilterDropdown
              label="Category"
              value={categoryFilter}
              options={[
                { label: 'All categories', value: '' },
                ...(response?.categories ?? []).map((category) => ({
                  label: category,
                  value: category,
                })),
              ]}
              onChange={setCategoryFilter}
            />
            <label className="block min-w-[180px]">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Saved views
              </span>
              <select
                defaultValue=""
                onChange={(event) => {
                  handleApplySavedFilter(event.target.value);
                  event.target.value = '';
                }}
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              >
                <option value="">Apply saved view</option>
                {locationSavedFilters.map((filter) => (
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
                message="Adjust the search or filters to find a different set of campus locations."
              />
            }
          />
        </div>
      </AdminSectionCard>

      <SidePanelEditor
        open={panelState.open}
        title={panelState.mode === 'edit' ? 'Edit location metadata' : 'View location metadata'}
        onClose={closePanel}
      >
        {panelLoading ? (
          <PanelSkeleton
            title="Loading location details"
            subtitle="Keeping the editor frame open while the selected location metadata streams in."
            lines={5}
          />
        ) : !panelDetail ? (
          <AdminEmptyState
            title="No location selected"
            message="Choose a location row to inspect or edit its metadata."
          />
        ) : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <LocationStatusBadge
                  status={panelDetail.location.status}
                  label={panelDetail.location.statusLabel}
                />
                <AdminStatusBadge>{panelDetail.location.category}</AdminStatusBadge>
              </div>
              <h3 className="mt-3 text-xl font-semibold text-slate-950">{panelDetail.location.name}</h3>
              <p className="mt-1 text-sm text-slate-600">
                Last updated {formatAdminDateTime(panelDetail.location.lastUpdated)}
              </p>
            </div>

            {([
              ['Name', 'name'],
              ['Category', 'type'],
              ['Short code', 'shortCode'],
              ['Campus ID', 'campusId'],
            ] as const).map(([label, key]) => (
              <label key={key} className="block">
                <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {label}
                </span>
                <input
                  type="text"
                  value={panelForm[key]}
                  readOnly={panelState.mode === 'view'}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setPanelForm((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  className={cx(
                    'w-full rounded-2xl border px-4 py-3 text-sm outline-none transition',
                    panelState.mode === 'view'
                      ? 'border-slate-200 bg-slate-100 text-slate-700'
                      : 'border-slate-200 bg-white text-slate-900 focus:border-sky-500 focus:ring-4 focus:ring-sky-100'
                  )}
                />
              </label>
            ))}

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Fellowships
                  </span>
                  <p className="mt-1 text-sm text-slate-600">Weekly schedules tied to this venue.</p>
                </div>
                {panelState.mode === 'edit' ? (
                  <button
                    type="button"
                    onClick={() =>
                      setPanelForm((current) => ({
                        ...current,
                        fellowships: [...current.fellowships, createEmptyFellowship()],
                      }))
                    }
                    className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    Add fellowship
                  </button>
                ) : null}
              </div>

              {panelForm.fellowships.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                  No fellowship schedules added.
                </div>
              ) : (
                <div className="space-y-3">
                  {panelForm.fellowships.map((entry, index) => {
                    const normalizedEntryCode = normalizeFellowshipCode(entry.code);
                    const fellowshipBrand = normalizedEntryCode
                      ? fellowshipBrandLookup[normalizedEntryCode] ?? null
                      : null;
                    const fellowshipBrandBusy = runningFellowshipBrandCode === normalizedEntryCode;
                    const uploadInputId = `fellowship_logo_input_${index}`;

                    return (
                      <div key={`fellowship_${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-900">Fellowship {index + 1}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          {panelState.mode === 'edit' ? (
                            <button
                              type="button"
                              onClick={() =>
                                setPanelForm((current) => ({
                                  ...current,
                                  fellowships: current.fellowships.map((item, entryIndex) =>
                                    entryIndex === index
                                      ? {
                                        ...item,
                                        services: [...item.services, createEmptyFellowshipService()],
                                      }
                                      : item
                                  ),
                                }))
                              }
                              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                            >
                              Add service
                            </button>
                          ) : null}
                          {panelState.mode === 'edit' ? (
                            <button
                              type="button"
                              onClick={() =>
                                setPanelForm((current) => ({
                                  ...current,
                                  fellowships: current.fellowships.filter((_, entryIndex) => entryIndex !== index),
                                }))
                              }
                              className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-50"
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="block">
                          <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Code</span>
                          <input
                            type="text"
                            value={entry.code ?? ''}
                            readOnly={panelState.mode === 'view'}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                              setPanelForm((current) => ({
                                ...current,
                                fellowships: current.fellowships.map((item, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                      ...item,
                                      code: event.target.value,
                                    }
                                    : item
                                ),
                              }))
                            }
                            className={cx(
                              'w-full rounded-2xl border px-4 py-3 text-sm outline-none transition',
                              panelState.mode === 'view'
                                ? 'border-slate-200 bg-white text-slate-700'
                                : 'border-slate-200 bg-white text-slate-900 focus:border-sky-500 focus:ring-4 focus:ring-sky-100'
                            )}
                          />
                        </label>

                        <div>
                          <label className="block">
                            <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Name</span>
                            <input
                              type="text"
                              value={fellowshipBrand?.name ?? entry.name ?? ''}
                              readOnly={panelState.mode === 'view'}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                setPanelForm((current) => ({
                                  ...current,
                                  fellowships: current.fellowships.map((item, entryIndex) =>
                                    entryIndex === index
                                      ? {
                                        ...item,
                                        name: event.target.value,
                                      }
                                      : item
                                  ),
                                }))
                              }
                              className={cx(
                                'w-full rounded-2xl border px-4 py-3 text-sm outline-none transition',
                                fellowshipBrand || panelState.mode === 'view'
                                  ? 'border-slate-200 bg-white text-slate-700'
                                  : 'border-slate-200 bg-white text-slate-900 focus:border-sky-500 focus:ring-4 focus:ring-sky-100'
                              )}
                            />
                            {fellowshipBrand ? (
                              <p className="mt-1 text-xs text-slate-500">Editing this name will update the shared brand for {normalizeFellowshipCode(entry.code)}</p>
                            ) : null}
                          </label>

                          <label className="block mt-3">
                            <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Contact</span>
                            <input
                              type="text"
                              value={fellowshipBrand?.contact ?? entry.contact ?? ''}
                              readOnly={panelState.mode === 'view'}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                setPanelForm((current) => ({
                                  ...current,
                                  fellowships: current.fellowships.map((item, entryIndex) =>
                                    entryIndex === index
                                      ? {
                                        ...item,
                                        contact: event.target.value,
                                      }
                                      : item
                                  ),
                                }))
                              }
                              className={cx(
                                'w-full rounded-2xl border px-4 py-3 text-sm outline-none transition',
                                fellowshipBrand || panelState.mode === 'view'
                                  ? 'border-slate-200 bg-white text-slate-700'
                                  : 'border-slate-200 bg-white text-slate-900 focus:border-sky-500 focus:ring-4 focus:ring-sky-100'
                              )}
                            />
                            {fellowshipBrand ? (
                              <p className="mt-1 text-xs text-slate-500">Editing this contact will update the shared brand for {normalizeFellowshipCode(entry.code)}</p>
                            ) : null}
                          </label>
                        </div>
                      </div>

                      <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                          <div className="flex items-center gap-4">
                            <FellowshipBrandBadge
                              code={normalizedEntryCode || 'Logo'}
                              logoUrl={fellowshipBrand?.logoUrl ?? null}
                              alt={`${entry.name || normalizedEntryCode || 'Fellowship'} badge`}
                              className="inline-flex h-16 w-16 items-center justify-center overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 p-2"
                              imageClassName="h-full w-full object-contain"
                              fallbackClassName="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700"
                            />

                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                                Shared badge
                              </p>
                              <p className="mt-1 text-sm font-semibold text-slate-900">
                                {normalizedEntryCode ? `${normalizedEntryCode} badge` : 'Choose a code first'}
                              </p>
                              <p className="mt-1 text-sm text-slate-600">
                                {normalizedEntryCode
                                  ? fellowshipBrand?.logoUrl
                                    ? 'This uploaded logo appears anywhere that fellowship code is used.'
                                    : 'No uploaded logo yet. The text badge stays live until you add one.'
                                  : 'Uploading stays disabled until this fellowship has a code.'}
                              </p>
                              {fellowshipBrand?.updatedAt ? (
                                <p className="mt-2 text-xs text-slate-500">
                                  Updated {formatAdminDateTime(fellowshipBrand.updatedAt)}
                                </p>
                              ) : null}
                            </div>
                          </div>

                          {panelState.mode === 'edit' ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <label
                                htmlFor={uploadInputId}
                                className={cx(
                                  baseButtonClassName,
                                  normalizedEntryCode
                                    ? 'cursor-pointer border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100'
                                    : 'border-slate-200 bg-slate-100 text-slate-400',
                                  fellowshipBrandBusy ? 'pointer-events-none' : ''
                                )}
                              >
                                {fellowshipBrandBusy
                                  ? 'Uploading...'
                                  : fellowshipBrand?.logoUrl
                                    ? 'Replace logo'
                                    : normalizedEntryCode
                                      ? 'Upload logo'
                                      : 'Choose code first'}
                              </label>
                              <input
                                id={uploadInputId}
                                type="file"
                                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                                className="sr-only"
                                disabled={!normalizedEntryCode || fellowshipBrandBusy}
                                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                                  const selectedFile = event.target.files?.[0] ?? null;
                                  event.target.value = '';
                                  void handleFellowshipLogoSelected(index, selectedFile);
                                }}
                              />

                              {fellowshipBrand?.logoUrl ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setFellowshipLogoRemovalState({
                                      open: true,
                                      code: normalizedEntryCode,
                                      name: entry.name || normalizedEntryCode,
                                    })
                                  }
                                  disabled={fellowshipBrandBusy}
                                  className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Remove logo
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        <p className="mt-3 text-xs text-slate-500">
                          Shared across every venue using {normalizedEntryCode || 'this fellowship code'}.
                        </p>
                      </div>

                      <div className="mt-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Service times
                          </p>
                          <p className="text-xs text-slate-500">
                            Add the exact room or class so students know where to go inside the building.
                          </p>
                        </div>

                        {entry.services.length === 0 ? (
                          <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
                            No service time added yet.
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {entry.services.map((service, serviceIndex) => (
                              <div key={`fellowship_${index}_service_${serviceIndex}`} className="rounded-2xl border border-white bg-white px-4 py-4 shadow-sm">
                                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                  <p className="text-sm font-semibold text-slate-900">Service {serviceIndex + 1}</p>
                                  {panelState.mode === 'edit' ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPanelForm((current) => ({
                                          ...current,
                                          fellowships: current.fellowships.map((item, entryIndex) =>
                                            entryIndex === index
                                              ? {
                                                ...item,
                                                services: item.services.filter((_, itemServiceIndex) => itemServiceIndex !== serviceIndex),
                                              }
                                              : item
                                          ),
                                        }))
                                      }
                                      className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-50"
                                    >
                                      Remove service
                                    </button>
                                  ) : null}
                                </div>

                                <div className="grid gap-3 md:grid-cols-2">
                                  <FilterDropdown
                                    label="Day"
                                    value={service.dayLabel ?? ''}
                                    disabled={panelState.mode === 'view'}
                                    options={fellowshipDayOptions}
                                    className="min-w-0"
                                    onChange={(value) =>
                                      setPanelForm((current) => ({
                                        ...current,
                                        fellowships: current.fellowships.map((item, entryIndex) =>
                                          entryIndex === index
                                            ? {
                                              ...item,
                                              services: item.services.map((serviceItem, itemServiceIndex) =>
                                                itemServiceIndex === serviceIndex
                                                  ? {
                                                    ...serviceItem,
                                                    dayLabel: value,
                                                  }
                                                  : serviceItem
                                              ),
                                            }
                                            : item
                                        ),
                                      }))
                                    }
                                  />

                                  <label className="block">
                                    <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                                      Time
                                    </span>
                                    <input
                                      type="time"
                                      value={toTimeInputValue(service.timeLabel)}
                                      disabled={panelState.mode === 'view'}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        setPanelForm((current) => ({
                                          ...current,
                                          fellowships: current.fellowships.map((item, entryIndex) =>
                                            entryIndex === index
                                              ? {
                                                ...item,
                                                services: item.services.map((serviceItem, itemServiceIndex) =>
                                                  itemServiceIndex === serviceIndex
                                                    ? {
                                                      ...serviceItem,
                                                      timeLabel: event.target.value,
                                                    }
                                                    : serviceItem
                                                ),
                                              }
                                              : item
                                          ),
                                        }))
                                      }
                                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100 disabled:cursor-default disabled:opacity-100"
                                    />
                                  </label>

                                  {([
                                    ['Room / class', 'roomLabel'],
                                    ['Info', 'infoLabel'],
                                  ] as const).map(([label, key]) => (
                                    <label key={key} className="block">
                                      <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                                        {label}
                                      </span>
                                      <input
                                        type="text"
                                        value={service[key] ?? ''}
                                        readOnly={panelState.mode === 'view'}
                                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                          setPanelForm((current) => ({
                                            ...current,
                                            fellowships: current.fellowships.map((item, entryIndex) =>
                                              entryIndex === index
                                                ? {
                                                  ...item,
                                                  services: item.services.map((serviceItem, itemServiceIndex) =>
                                                    itemServiceIndex === serviceIndex
                                                      ? {
                                                        ...serviceItem,
                                                        [key]: event.target.value,
                                                      }
                                                      : serviceItem
                                                  ),
                                                }
                                                : item
                                            ),
                                          }))
                                        }
                                        className={cx(
                                          'w-full rounded-2xl border px-4 py-3 text-sm outline-none transition',
                                          panelState.mode === 'view'
                                            ? 'border-slate-200 bg-white text-slate-700'
                                            : 'border-slate-200 bg-white text-slate-900 focus:border-sky-500 focus:ring-4 focus:ring-sky-100'
                                        )}
                                      />
                                    </label>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <div className="space-y-2">
                <div className="text-sm text-slate-600">
                  Building ID <span className="font-semibold text-slate-900">{panelDetail.location.buildingId}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenDatasetAccessEditor(panelDetail.location.featureId)}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                >
                  Edit entrances on map
                </button>
              </div>
              {panelState.mode === 'edit' ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleSavePanel();
                  }}
                  disabled={savingPanel}
                  className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingPanel ? 'Saving...' : 'Save metadata'}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </SidePanelEditor>

      <SidePanelEditor
        open={bulkReportDraft.open}
        title="Add bulk report"
        description={`${selectedRows.length} selected`}
        onClose={() =>
          setBulkReportDraft({
            open: false,
            powerStatus: true,
            note: '',
          })
        }
      >
        <div className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
            Publishes immediately.
          </div>

          <FilterDropdown
            label="Report status"
            value={bulkReportDraft.powerStatus ? 'available' : 'unavailable'}
            options={[
              { label: 'Available', value: 'available' },
              { label: 'Unavailable', value: 'unavailable' },
            ]}
            onChange={(value) =>
              setBulkReportDraft((current) => ({
                ...current,
                powerStatus: value === 'available',
              }))
            }
          />

          <label className="block">
            <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Report note
            </span>
            <textarea
              value={bulkReportDraft.note}
              onChange={(event) =>
                setBulkReportDraft((current) => ({
                  ...current,
                  note: event.target.value,
                }))
              }
              rows={4}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              placeholder="Optional note for the selected report set"
            />
          </label>

          <button
            type="button"
            onClick={() => {
              void executeBulkAction(bulkReportDraft.powerStatus ? 'turn_on' : 'turn_off', bulkReportDraft.note);
            }}
            disabled={runningBulkAction || selectedRows.length === 0}
            className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningBulkAction ? 'Publishing...' : `Apply to ${selectedRows.length} locations`}
          </button>
        </div>
      </SidePanelEditor>

      <ConfirmationModal
        open={confirmState.open && Boolean(confirmState.action)}
        title={confirmState.action ? bulkActionLabel(confirmState.action) : 'Confirm bulk action'}
        message={
          confirmState.action
            ? `Apply "${bulkActionLabel(confirmState.action)}" to ${confirmState.count} selected location(s)?`
            : ''
        }
        confirmLabel={confirmState.action ? bulkActionLabel(confirmState.action) : 'Confirm'}
        onCancel={() =>
          setConfirmState({
            open: false,
            action: null,
            count: 0,
          })
        }
        onConfirm={() => {
          if (!confirmState.action) {
            return;
          }

          void executeBulkAction(confirmState.action);
        }}
        tone={confirmState.action === 'turn_off' ? 'danger' : 'default'}
        busy={runningBulkAction}
      />
      <ConfirmationModal
        open={deleteConfirmState.open && deleteConfirmState.rows.length > 0}
        title={deleteConfirmState.rows.length > 1 ? 'Delete selected locations?' : 'Delete location?'}
        message={
          deleteConfirmState.rows.length > 1
            ? `Delete ${deleteConfirmState.rows.length} selected locations from the live locations dataset? This removes them immediately.`
            : deleteConfirmState.rows[0]
            ? `Delete ${deleteConfirmState.rows[0].name} from the live locations dataset? This removes it immediately.`
            : ''
        }
        confirmLabel={deleteConfirmState.rows.length > 1 ? 'Delete selected' : 'Delete location'}
        onCancel={() =>
          setDeleteConfirmState({
            open: false,
            rows: [],
          })
        }
        onConfirm={() => {
          if (deleteConfirmState.rows.length === 0) {
            return;
          }

          void handleDeleteLocations(deleteConfirmState.rows);
        }}
        tone="danger"
        busy={runningDeleteAction}
      />
      <ConfirmationModal
        open={fellowshipLogoRemovalState.open && Boolean(fellowshipLogoRemovalState.code)}
        title="Remove fellowship badge?"
        message={
          fellowshipLogoRemovalState.code
            ? `Remove the shared badge for ${fellowshipLogoRemovalState.name || fellowshipLogoRemovalState.code}? Every venue using ${fellowshipLogoRemovalState.code} will fall back to the text badge.`
            : ''
        }
        confirmLabel="Remove logo"
        onCancel={() =>
          setFellowshipLogoRemovalState({
            open: false,
            code: '',
            name: '',
          })
        }
        onConfirm={() => {
          void handleRemoveFellowshipLogo();
        }}
        tone="danger"
        busy={
          normalizeFellowshipCode(fellowshipLogoRemovalState.code) === runningFellowshipBrandCode
        }
      />
      <TextEntryModal
        open={saveViewOpen}
        title="Save locations view"
        description="Save the current location filters and sorting for quick access later."
        label="View name"
        value={saveViewName}
        placeholder="For example: Unavailable buildings"
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
