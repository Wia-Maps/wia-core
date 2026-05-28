import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { clientConfig } from '../../config/client';
import { useAdminAuth } from '../../context/AdminAuthContext';
import useDebouncedValue from '../../hooks/useDebouncedValue';
import { useToast } from '../../context/ToastContext';
import {
  fetchAdminActivity,
  fetchAdminLocations,
  fetchCampusLocations,
  fetchRecentPowerReports,
  getAdminApiError,
  type CampusLocationRecord,
  type PowerReportRecord,
} from '../../services/adminApi';
import {
  readAdminPreferences,
  removeSavedFilter,
  upsertSavedFilter,
  writeAdminPreferences,
  type AdminPreferenceRecord,
} from '../../services/adminPreferences';
import { fetchPublicMapDataset } from '../../services/mapDatasets';
import { AppShellLoader } from '../LoadingPrimitives';
import { publishAdminLocationFocus } from './adminPageUtils';
import { AdminLoginPage } from './AdminLoginPage';
import {
  ADMIN_ROUTE_META,
  type AdminDatasetManagerFocusRequest,
  formatDatasetLabel,
  formatRelativeTime,
  type AdminDatasetSummary,
  type AdminRoute,
  type AdminWorkspaceState,
} from './adminWorkspace';
import { AdminSidebarItem, cx } from './AdminUi';

const AdminDashboardPage = lazy(() => import('./AdminDashboardPage'));
const AdminLocationsPage = lazy(() => import('./AdminLocationsPage'));
const AdminPowerControlPage = lazy(() => import('./AdminPowerControlPage'));
const AdminRouteWorkflowsPage = lazy(() => import('./AdminRouteWorkflows'));
const AdminDatasetManagerPage = lazy(() => import('./AdminDatasetManagerPage'));
const AdminActivityLogPage = lazy(() => import('./AdminActivityLogPage'));
const AdminSettingsPage = lazy(() => import('./AdminSettingsPage'));

interface AdminShellProps {
  route: AdminRoute;
  onClose: () => void;
  onNavigate: (route: AdminRoute) => void;
}

const DESKTOP_SIDEBAR_KEY = 'wia-admin-sidebar-collapsed';

const readDesktopSidebarCollapsed = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(DESKTOP_SIDEBAR_KEY) === '1';
};

const MenuIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const DashboardIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path d="M4 13h7V4H4v9Zm9 7h7V4h-7v16ZM4 20h7v-5H4v5Z" fill="currentColor" />
  </svg>
);

const LocationsIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path
      d="M6 19h12M8.5 19V8.5a3.5 3.5 0 1 1 7 0V19M5 19V9a7 7 0 1 1 14 0v10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PowerIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path d="M12 3.4 6.2 13h3.6L8.9 20.6l6-9.8h-3.4L12 3.4Z" fill="currentColor" />
  </svg>
);

const RoutesIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path
      d="M6 6h4v4H6V6Zm8 8h4v4h-4v-4ZM8 10l8 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const DatasetIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path
      d="M5 7h14M5 12h14M5 17h8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const ActivityIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path
      d="M4 13h4l2.4-6 3.2 10 2.2-6H20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SettingsIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
    <path
      d="m12 3 1.8 2.8 3.2.6-.9 3.1 2.3 2.4-2.3 2.4.9 3.1-3.2.6L12 21l-1.8-2.8-3.2-.6.9-3.1-2.3-2.4 2.3-2.4-.9-3.1 3.2-.6L12 3Zm0 5.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ArrowLeftIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M15 18 9 12l6-6M10 12h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LogoutIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="M10 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4M14 16l4-4-4-4M18 12H9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SearchIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      d="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CollapseIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ExpandIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const WorkspaceMark: React.FC = () => (
  <div className="grid h-11 w-11 place-items-center rounded-2xl bg-sky-600 text-white shadow-sm">
    <DashboardIcon />
  </div>
);

const navIcons: Record<AdminRoute, ReactNode> = {
  dashboard: <DashboardIcon />,
  locations: <LocationsIcon />,
  power: <PowerIcon />,
  routes: <RoutesIcon />,
  datasets: <DatasetIcon />,
  activity: <ActivityIcon />,
  settings: <SettingsIcon />,
};

const toDatasetSummary = (
  datasetType: 'locations' | 'routing',
  version: string,
  updatedAt: string,
  featureCount: number
): AdminDatasetSummary => ({
  datasetType,
  version,
  updatedAt,
  featureCount,
});

const summarizePublicReports = (locations: CampusLocationRecord[], reports: PowerReportRecord[]) => {
  const latestReports = new Map<string, PowerReportRecord>();

  reports.forEach((report) => {
    const current = latestReports.get(report.locationId);
    if (!current || new Date(report.reportedAt).getTime() > new Date(current.reportedAt).getTime()) {
      latestReports.set(report.locationId, report);
    }
  });

  const availableCount = [...latestReports.values()].filter((report) => report.powerStatus).length;
  const unavailableCount = [...latestReports.values()].filter((report) => !report.powerStatus).length;

  return {
    availableCount,
    unavailableCount,
    noReportCount: Math.max(0, locations.length - latestReports.size),
    reportsByLocationId: latestReports,
  };
};

export const AdminShell: React.FC<AdminShellProps> = ({ route, onClose, onNavigate }) => {
  const { admin, isAuthenticated, loading: authLoading, authState, logout } = useAdminAuth();
  const { showError, showSuccess } = useToast();
  const [workspace, setWorkspace] = useState<AdminWorkspaceState>({
    isAuthenticated: false,
    adminEmail: null,
    locations: [],
    reports: [],
    locationsResponse: null,
    activityResponse: null,
    locationsById: new Map(),
    reportsByLocationId: new Map(),
    availableCount: 0,
    unavailableCount: 0,
    noReportCount: 0,
    latestActivity: null,
    datasetSummaries: [],
    latestDatasetSummary: null,
    lastRefreshedAt: null,
    loadState: 'loading',
    loading: true,
    catalogLoading: false,
    updatingLocationId: null,
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState<boolean>(() => readDesktopSidebarCollapsed());
  const [preferences, setPreferences] = useState<AdminPreferenceRecord>(() => readAdminPreferences());
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const debouncedCommandQuery = useDebouncedValue(commandQuery, 250);
  const [commandLocations, setCommandLocations] = useState<Array<{ id: string; title: string; subtitle: string }>>([]);
  const [pendingDatasetManagerFocus, setPendingDatasetManagerFocus] = useState<AdminDatasetManagerFocusRequest | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const currentPageMeta = ADMIN_ROUTE_META[route];
  const workspaceTitle = clientConfig.admin.workspaceTitle || 'Admin workspace';

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    try {
      const [locationsDataset, routingDataset] = await Promise.all([
        fetchPublicMapDataset('locations'),
        fetchPublicMapDataset('routing'),
      ]);

      const datasetSummaries = [
        toDatasetSummary(
          'locations',
          locationsDataset.version,
          locationsDataset.updatedAt,
          locationsDataset.collection.features.length
        ),
        toDatasetSummary(
          'routing',
          routingDataset.version,
          routingDataset.updatedAt,
          routingDataset.collection.features.length
        ),
      ];
      const latestDatasetSummary =
        [...datasetSummaries].sort(
          (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
        )[0] ?? null;

      if (isAuthenticated) {
        const [locationsResponse, activityResponse] = await Promise.all([
          fetchAdminLocations({ page: 1, pageSize: 1 }),
          fetchAdminActivity({ page: 1, pageSize: 6 }),
        ]);

        setWorkspace({
          isAuthenticated,
          adminEmail: admin?.email ?? null,
          locations: [],
          reports: [],
          locationsResponse,
          activityResponse,
          locationsById: new Map(),
          reportsByLocationId: new Map(),
          availableCount: locationsResponse.summary.availableCount,
          unavailableCount: locationsResponse.summary.unavailableCount,
          noReportCount: locationsResponse.summary.noReportCount,
          latestActivity: null,
          datasetSummaries,
          latestDatasetSummary,
          lastRefreshedAt: new Date().toISOString(),
          loadState: 'ready',
          loading: false,
          catalogLoading: false,
          updatingLocationId: null,
        });
        return;
      }

      const [locations, reports] = await Promise.all([
        fetchCampusLocations(),
        fetchRecentPowerReports(250),
      ]);

      const { availableCount, unavailableCount, noReportCount, reportsByLocationId } =
        summarizePublicReports(locations, reports);

      setWorkspace({
        isAuthenticated,
        adminEmail: admin?.email ?? null,
        locations,
        reports,
        locationsResponse: null,
        activityResponse: null,
        locationsById: new Map(locations.map((location) => [location.locationId, location])),
        reportsByLocationId,
        availableCount,
        unavailableCount,
        noReportCount,
        latestActivity: reports[0] ?? null,
          datasetSummaries,
          latestDatasetSummary,
          lastRefreshedAt: new Date().toISOString(),
          loadState: 'ready',
          loading: false,
          catalogLoading: false,
          updatingLocationId: null,
      });
    } catch (error) {
      showError(getAdminApiError(error), {
        title: 'Admin workspace',
        dedupeKey: 'admin-workspace-refresh',
      });
      setWorkspace((current) => ({
        ...current,
        loadState: 'error',
        loading: false,
        catalogLoading: false,
      }));
    }
  }, [admin?.email, isAuthenticated, showError]);

  useEffect(() => {
    setWorkspace((current) => ({
      ...current,
      loadState: 'loading',
      loading: true,
      catalogLoading: true,
    }));
    void refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(DESKTOP_SIDEBAR_KEY, desktopSidebarCollapsed ? '1' : '0');
  }, [desktopSidebarCollapsed]);

  useEffect(() => {
    setSidebarOpen(false);
    setCommandOpen(false);
    setCommandQuery('');
  }, [route]);

  useEffect(() => {
    if (!commandOpen || !isAuthenticated || debouncedCommandQuery.trim().length < 2) {
      setCommandLocations([]);
      return;
    }

    let cancelled = false;

    const loadCommandLocations = async (): Promise<void> => {
      try {
        const result = await fetchAdminLocations({
          page: 1,
          pageSize: 6,
          search: debouncedCommandQuery.trim(),
        });

        if (cancelled) {
          return;
        }

        setCommandLocations(
          result.items.map((row) => ({
            id: row.locationId,
            title: row.name,
            subtitle: `${row.buildingId} | ${row.category}`,
          }))
        );
      } catch {
        if (!cancelled) {
          setCommandLocations([]);
        }
      }
    };

    void loadCommandLocations();

    return () => {
      cancelled = true;
    };
  }, [commandOpen, debouncedCommandQuery, isAuthenticated]);

  useEffect(() => {
    if (!commandOpen) {
      return;
    }

    searchInputRef.current?.focus();
  }, [commandOpen]);

  useEffect(() => {
    if (!commandOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!searchContainerRef.current?.contains(event.target as Node)) {
        setCommandOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [commandOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (preferences.showKeyboardShortcuts && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((current) => !current);
        return;
      }

      if (event.key !== 'Escape') {
        return;
      }

      if (commandOpen) {
        setCommandOpen(false);
        return;
      }

      if (sidebarOpen) {
        setSidebarOpen(false);
        return;
      }

      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [commandOpen, onClose, preferences.showKeyboardShortcuts, sidebarOpen]);

  const updatePreferences = useCallback(
    (updater: (current: AdminPreferenceRecord) => AdminPreferenceRecord): void => {
      setPreferences((current) => {
        const next = updater(current);
        writeAdminPreferences(next);
        return next;
      });
    },
    []
  );

  const handleSaveFilter = useCallback(
    (page: 'locations' | 'power' | 'activity', name: string, query: Record<string, unknown>): void => {
      const next = upsertSavedFilter(page, name, query);
      setPreferences(next);
    },
    []
  );

  const handleRemoveSavedFilter = useCallback((filterId: string): void => {
    const next = removeSavedFilter(filterId);
    setPreferences(next);
  }, []);

  const handleLogout = (): void => {
    logout();
    showSuccess('You have been signed out.', {
      title: 'Signed out',
      dedupeKey: 'admin-sign-out',
    });
  };

  const routeCommandItems = useMemo(() => {
    const normalizedQuery = commandQuery.trim().toLowerCase();

    return (Object.values(ADMIN_ROUTE_META) as Array<(typeof ADMIN_ROUTE_META)[AdminRoute]>)
      .filter((meta) => {
        if (!normalizedQuery) {
          return true;
        }

        return (
          meta.label.toLowerCase().includes(normalizedQuery) ||
          meta.description.toLowerCase().includes(normalizedQuery)
        );
      })
      .map((meta) => ({
        id: meta.route,
        title: meta.label,
        subtitle: meta.description,
        onSelect: () => {
          onNavigate(meta.route);
          setCommandOpen(false);
          setCommandQuery('');
        },
      }));
  }, [commandQuery, onNavigate]);

  const locationCommandItems = useMemo(() => {
    return commandLocations.map((location) => ({
      id: location.id,
      title: location.title,
      subtitle: location.subtitle,
      onSelect: () => {
        onNavigate('locations');
        setCommandOpen(false);
        setCommandQuery('');
        // Delay focus event to allow AdminLocationsPage to mount and attach listener
        window.setTimeout(() => {
          publishAdminLocationFocus(location.id);
        }, 100);
      },
    }));
  }, [commandLocations, onNavigate]);

  const showInlineSearchResults = commandOpen && (routeCommandItems.length > 0 || locationCommandItems.length > 0);

  const handleOpenDatasetAccessEditor = useCallback((featureId: string): void => {
    setPendingDatasetManagerFocus({
      datasetType: 'locations',
      featureId,
      revealSection: 'access-points',
    });
    onNavigate('datasets');
  }, [onNavigate]);

  const renderPage = (): JSX.Element => {
    if (route === 'locations') {
      return (
        <AdminLocationsPage
          enabled={isAuthenticated}
          dense={preferences.denseMode}
          defaultPageSize={preferences.defaultPageSize}
          autoRefresh={preferences.autoRefresh}
          savedFilters={preferences.savedFilters}
          onSaveFilter={handleSaveFilter}
          onWorkspaceRefresh={refreshWorkspace}
          onOpenDatasetAccessEditor={handleOpenDatasetAccessEditor}
        />
      );
    }

    if (route === 'power') {
      return (
        <AdminPowerControlPage
          enabled={isAuthenticated}
          dense={preferences.denseMode}
          defaultPageSize={preferences.defaultPageSize}
          autoRefresh={preferences.autoRefresh}
          savedFilters={preferences.savedFilters}
          onSaveFilter={handleSaveFilter}
          onWorkspaceRefresh={refreshWorkspace}
        />
      );
    }

    if (route === 'routes') {
      return (
        <AdminRouteWorkflowsPage
          enabled={isAuthenticated}
          onWorkspaceRefresh={refreshWorkspace}
        />
      );
    }

    if (route === 'datasets') {
      return (
        <AdminDatasetManagerPage
          enabled={isAuthenticated}
          onLocationsChanged={refreshWorkspace}
          pendingFocusRequest={pendingDatasetManagerFocus}
          onConsumeFocusRequest={() => setPendingDatasetManagerFocus(null)}
        />
      );
    }

    if (route === 'activity') {
      return (
        <AdminActivityLogPage
          enabled={isAuthenticated}
          dense={preferences.denseMode}
          defaultPageSize={preferences.defaultPageSize}
          autoRefresh={preferences.autoRefresh}
          savedFilters={preferences.savedFilters}
          onSaveFilter={handleSaveFilter}
          onWorkspaceRefresh={refreshWorkspace}
        />
      );
    }

    if (route === 'settings') {
      return (
        <AdminSettingsPage
          preferences={preferences}
          onUpdatePreferences={updatePreferences}
          onRemoveSavedFilter={handleRemoveSavedFilter}
        />
      );
    }

    return <AdminDashboardPage workspace={workspace} onNavigate={onNavigate} />;
  };

  return (
    <div className="pointer-events-auto h-full w-full bg-[#f4f7fb] text-slate-900">
      <div className="flex h-full min-h-full">
        <div
          className={cx(
            'fixed inset-0 z-30 bg-slate-950/30 transition lg:hidden',
            sidebarOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
          )}
          onClick={() => setSidebarOpen(false)}
        />

        <aside
          className={cx(
            'fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col border-r border-slate-200 bg-white transition-[width,transform] duration-200',
            'w-[286px] lg:static lg:translate-x-0',
            desktopSidebarCollapsed ? 'lg:w-[92px]' : 'lg:w-[280px]',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <div className={cx('border-b border-slate-200', desktopSidebarCollapsed ? 'px-4 py-5' : 'px-5 py-5')}>
            <div className={cx('flex items-center', desktopSidebarCollapsed ? 'justify-center' : 'justify-between gap-3')}>
              <div className={cx('flex items-center', desktopSidebarCollapsed ? 'justify-center' : 'gap-3')}>
                <WorkspaceMark />
                {!desktopSidebarCollapsed ? (
                  <div className="min-w-0">
                    <h2 className="font-['Outfit'] text-xl font-semibold text-slate-950">{workspaceTitle}</h2>
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => setDesktopSidebarCollapsed((current) => !current)}
                title={desktopSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-label={desktopSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className={cx(
                  'hidden rounded-full border border-slate-200 bg-white text-slate-700 transition hover:border-slate-300 hover:text-slate-950 lg:inline-flex',
                  desktopSidebarCollapsed ? 'h-9 w-9 items-center justify-center' : 'h-9 w-9 items-center justify-center'
                )}
              >
                {desktopSidebarCollapsed ? <ExpandIcon /> : <CollapseIcon />}
              </button>
            </div>
          </div>

          <div className={cx('flex-1 overflow-y-auto', desktopSidebarCollapsed ? 'px-3 py-4' : 'px-4 py-5')}>
            <div className="space-y-2">
              {(Object.values(ADMIN_ROUTE_META) as Array<(typeof ADMIN_ROUTE_META)[AdminRoute]>).map((meta) => (
                <AdminSidebarItem
                  key={meta.route}
                  active={route === meta.route}
                  icon={navIcons[meta.route]}
                  label={meta.navLabel}
                  collapsed={desktopSidebarCollapsed}
                  onClick={() => onNavigate(meta.route)}
                />
              ))}
            </div>

            {!desktopSidebarCollapsed ? (
              <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4">
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-[auto,minmax(0,1fr)] items-center gap-3">
                    <span className="text-slate-500">Operator</span>
                    <span
                      className="truncate text-right font-medium text-slate-900"
                      title={authState === 'loading' ? 'Checking session' : admin?.email ?? 'View only'}
                    >
                      {authState === 'loading' ? 'Checking session' : admin?.email ?? 'View only'}
                    </span>
                  </div>
                  <div className="grid grid-cols-[auto,minmax(0,1fr)] items-center gap-3">
                    <span className="text-slate-500">Refresh</span>
                    <span className="truncate text-right font-medium text-slate-900">
                      {workspace.lastRefreshedAt ? formatRelativeTime(workspace.lastRefreshedAt) : 'Pending'}
                    </span>
                  </div>
                  {workspace.latestDatasetSummary ? (
                    <div className="grid grid-cols-[auto,minmax(0,1fr)] items-center gap-3 border-t border-slate-200 pt-3">
                      <span className="text-slate-500">{formatDatasetLabel(workspace.latestDatasetSummary.datasetType)}</span>
                      <span className="truncate text-right font-medium text-slate-900">
                        {formatRelativeTime(workspace.latestDatasetSummary.updatedAt)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className={cx('border-t border-slate-200 py-4', desktopSidebarCollapsed ? 'px-3' : 'px-4')}>
            <div className="space-y-2">
              <button
                type="button"
                onClick={onClose}
                title="Back to map"
                className={cx(
                  'flex w-full items-center rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950',
                  desktopSidebarCollapsed ? 'justify-center px-3 py-3' : 'justify-center gap-2 px-4 py-3'
                )}
              >
                <ArrowLeftIcon />
                {!desktopSidebarCollapsed ? 'Back to map' : null}
              </button>
              {isAuthenticated ? (
                <button
                  type="button"
                  onClick={handleLogout}
                  title="Sign out"
                  className={cx(
                    'flex w-full items-center rounded-2xl border border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-950',
                    desktopSidebarCollapsed ? 'justify-center px-3 py-3' : 'justify-center gap-2 px-4 py-3'
                  )}
                >
                  <LogoutIcon />
                  {!desktopSidebarCollapsed ? 'Sign out' : null}
                </button>
              ) : null}
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-[#f4f7fb]/95 backdrop-blur">
            <div className="px-4 py-4 md:px-6 xl:px-8">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 transition hover:border-slate-300 hover:text-slate-950 lg:hidden"
                  >
                    <MenuIcon />
                  </button>
                  <div className="min-w-0">
                    <h1 className="font-['Outfit'] text-2xl font-semibold text-slate-950 md:text-3xl">
                      {currentPageMeta.label}
                    </h1>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div ref={searchContainerRef} className="relative">
                    <div
                      className={cx(
                        'flex h-11 items-center overflow-hidden rounded-full border bg-white shadow-sm transition-[width,border-color,box-shadow] duration-200 ease-out',
                        commandOpen
                          ? 'w-[min(24rem,calc(100vw-3rem))] border-sky-300 shadow-[0_10px_30px_rgba(14,165,233,0.12)]'
                          : 'w-11 border-slate-300 hover:border-slate-400'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setCommandOpen(true)}
                        aria-label="Open search"
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-slate-700 transition hover:text-slate-950"
                      >
                        <SearchIcon />
                      </button>
                      <input
                        ref={searchInputRef}
                        type="text"
                        value={commandQuery}
                        onChange={(event) => {
                          if (!commandOpen) {
                            setCommandOpen(true);
                          }
                          setCommandQuery(event.target.value);
                        }}
                        onFocus={() => setCommandOpen(true)}
                        placeholder="Search pages and locations..."
                        className={cx(
                          'h-11 min-w-0 flex-1 bg-transparent pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 transition-opacity duration-150',
                          commandOpen ? 'opacity-100' : 'pointer-events-none w-0 opacity-0'
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setCommandOpen(false);
                          setCommandQuery('');
                        }}
                        aria-label="Close search"
                        className={cx(
                          'mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700',
                          commandOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
                        )}
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                          <path
                            d="M6 6l12 12M18 6 6 18"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>

                    <div
                      className={cx(
                        'absolute right-0 top-[calc(100%+0.5rem)] z-30 w-[min(28rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.16)] transition-all duration-200 ease-out',
                        showInlineSearchResults
                          ? 'pointer-events-auto translate-y-0 opacity-100'
                          : 'pointer-events-none -translate-y-2 opacity-0'
                      )}
                    >
                      <div className="max-h-[24rem] overflow-y-auto px-3 py-3">
                        {routeCommandItems.length > 0 ? (
                          <div>
                            <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                              Pages
                            </div>
                            <div className="space-y-1">
                              {routeCommandItems.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  onClick={item.onSelect}
                                  className="flex w-full flex-col rounded-2xl px-3 py-3 text-left transition hover:bg-slate-50"
                                >
                                  <span className="text-sm font-semibold text-slate-900">{item.title}</span>
                                  {item.subtitle ? <span className="mt-1 text-xs text-slate-500">{item.subtitle}</span> : null}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {locationCommandItems.length > 0 ? (
                          <div className={routeCommandItems.length > 0 ? 'mt-3 border-t border-slate-100 pt-3' : undefined}>
                            <div className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                              Locations
                            </div>
                            <div className="space-y-1">
                              {locationCommandItems.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  onClick={item.onSelect}
                                  className="flex w-full flex-col rounded-2xl px-3 py-3 text-left transition hover:bg-slate-50"
                                >
                                  <span className="text-sm font-semibold text-slate-900">{item.title}</span>
                                  {item.subtitle ? <span className="mt-1 text-xs text-slate-500">{item.subtitle}</span> : null}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {commandOpen && commandQuery.trim().length >= 2 && locationCommandItems.length === 0 ? (
                          <div className={routeCommandItems.length > 0 ? 'mt-3 border-t border-slate-100 px-3 pt-4 pb-2' : 'px-3 py-2'}>
                            <p className="text-sm text-slate-500">No matching locations found.</p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void refreshWorkspace();
                    }}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                  >
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          </header>

          <main className="relative min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1680px] p-4 md:p-6 xl:p-8">
              <Suspense
                fallback={
                  <AppShellLoader
                    compact
                    title="Loading admin workspace"
                    subtitle="Keeping the admin frame visible while the active page chunk streams in."
                  />
                }
              >
                {renderPage()}
              </Suspense>
            </div>

            {!isAuthenticated && !authLoading ? <AdminLoginPage /> : null}
          </main>
        </div>
      </div>
    </div>
  );
};
