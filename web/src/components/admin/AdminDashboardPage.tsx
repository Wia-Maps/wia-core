import type { AdminRoute, AdminWorkspaceState } from './adminWorkspace';
import { formatDatasetLabel, formatRelativeTime } from './adminWorkspace';
import { AdminSectionCard, AdminStatCard } from './AdminUi';

interface AdminDashboardPageProps {
  workspace: AdminWorkspaceState;
  onNavigate: (route: AdminRoute) => void;
}

const QuickActionButton: React.FC<{
  label: string;
  onClick: () => void;
}> = ({ label, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-sky-300 hover:bg-sky-50"
    >
      <p className="text-sm font-semibold text-slate-950">{label}</p>
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Open</span>
    </button>
  );
};

const DashboardSkeletonCard: React.FC = () => {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
      <div className="loading-shimmer h-3.5 w-24 rounded-full bg-slate-200/85" />
      <div className="loading-shimmer mt-3 h-9 w-20 rounded-2xl bg-slate-200/85" />
      <div className="loading-shimmer mt-3 h-3.5 w-28 rounded-full bg-slate-200/85" />
    </div>
  );
};

export default function AdminDashboardPage({
  workspace,
  onNavigate,
}: AdminDashboardPageProps): JSX.Element {
  const totalLocations =
    workspace.locationsResponse?.summary.totalLocations ??
    workspace.datasetSummaries.find((summary) => summary.datasetType === 'locations')?.featureCount ??
    0;

  return (
    <div className="space-y-6">
      <AdminSectionCard
        label="Snapshot"
      >
        {workspace.loadState === 'loading' ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <DashboardSkeletonCard key={`dashboard_stat_${index}`} />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <AdminStatCard
              label="Locations total"
              value={totalLocations}
              hint="Live dataset"
            />
            <AdminStatCard
              label="Available locations"
              value={workspace.availableCount}
              hint="Power ON"
              tone="success"
            />
            <AdminStatCard
              label="Unavailable locations"
              value={workspace.unavailableCount}
              hint="Power OFF"
              tone="danger"
            />
            <AdminStatCard
              label="Without report"
              value={workspace.noReportCount}
              hint="Waiting"
              tone="warning"
            />
            <AdminStatCard
              label="Last dataset publish"
              value={
                workspace.latestDatasetSummary ? formatRelativeTime(workspace.latestDatasetSummary.updatedAt) : 'Pending'
              }
              hint={
                workspace.latestDatasetSummary
                  ? formatDatasetLabel(workspace.latestDatasetSummary.datasetType)
                  : 'No publish'
              }
              tone="info"
            />
          </div>
        )}
      </AdminSectionCard>

      <AdminSectionCard
        label="Quick actions"
        title="Go to"
      >
        {workspace.loadState === 'loading' ? (
          <div className="grid gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={`dashboard_action_${index}`} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                <div className="loading-shimmer h-4 w-32 rounded-full bg-slate-200/85" />
                <div className="loading-shimmer mt-6 h-3.5 w-12 rounded-full bg-slate-200/85" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-4">
            <QuickActionButton
              label="Update power status"
              onClick={() => onNavigate('power')}
            />
            <QuickActionButton
              label="Review route candidates"
              onClick={() => onNavigate('routes')}
            />
            <QuickActionButton
              label="Manage datasets"
              onClick={() => onNavigate('datasets')}
            />
            <QuickActionButton
              label="View locations"
              onClick={() => onNavigate('locations')}
            />
          </div>
        )}
      </AdminSectionCard>
    </div>
  );
}
