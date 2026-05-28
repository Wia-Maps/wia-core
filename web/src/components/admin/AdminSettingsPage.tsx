import type {
  AdminPreferenceRecord,
  SavedFilterRecord,
} from '../../services/adminPreferences';
import { formatAbsoluteTime } from './adminWorkspace';
import { AdminEmptyState, AdminSectionCard, AdminStatusBadge } from './AdminUi';

interface AdminSettingsPageProps {
  preferences: AdminPreferenceRecord;
  onUpdatePreferences: (updater: (current: AdminPreferenceRecord) => AdminPreferenceRecord) => void;
  onRemoveSavedFilter: (filterId: string) => void;
}

const summarizeFilterQuery = (query: Record<string, unknown>): string[] => {
  return Object.entries(query)
    .filter(([, value]) => value !== '' && value !== null && typeof value !== 'undefined')
    .map(([key, value]) => `${key}: ${String(value)}`);
};

const SettingToggle: React.FC<{
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ title, description, checked, onChange }) => {
  return (
    <label className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
      <span>
        <span className="block text-sm font-semibold text-slate-950">{title}</span>
        <span className="mt-2 block text-sm leading-6 text-slate-600">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-5 w-5 rounded border-slate-300 text-sky-600"
      />
    </label>
  );
};

const SavedFilterCard: React.FC<{
  filter: SavedFilterRecord;
  onRemove: () => void;
}> = ({ filter, onRemove }) => {
  const summary = summarizeFilterQuery(filter.query);

  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <AdminStatusBadge>{filter.page}</AdminStatusBadge>
        <AdminStatusBadge tone="info">{formatAbsoluteTime(filter.createdAt)}</AdminStatusBadge>
      </div>
      <h3 className="mt-3 text-lg font-semibold text-slate-950">{filter.name}</h3>
      {summary.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {summary.map((item) => (
            <AdminStatusBadge key={item}>{item}</AdminStatusBadge>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-600">No filters stored.</p>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="mt-4 rounded-full border border-rose-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:bg-rose-50"
      >
        Remove saved filter
      </button>
    </article>
  );
};

export default function AdminSettingsPage({
  preferences,
  onUpdatePreferences,
  onRemoveSavedFilter,
}: AdminSettingsPageProps): JSX.Element {
  return (
    <div className="space-y-6">
      <AdminSectionCard
        label="Settings"
        title="Workspace preferences"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingToggle
            title="Compact tables"
            description="Fit more rows on screen."
            checked={preferences.denseMode}
            onChange={(checked) =>
              onUpdatePreferences((current) => ({
                ...current,
                denseMode: checked,
              }))
            }
          />
          <SettingToggle
            title="Auto-refresh"
            description="Refresh pages every minute."
            checked={preferences.autoRefresh}
            onChange={(checked) =>
              onUpdatePreferences((current) => ({
                ...current,
                autoRefresh: checked,
              }))
            }
          />
          <SettingToggle
            title="Keyboard shortcuts"
            description="Enable shortcuts like Cmd/Ctrl+K."
            checked={preferences.showKeyboardShortcuts}
            onChange={(checked) =>
              onUpdatePreferences((current) => ({
                ...current,
                showKeyboardShortcuts: checked,
              }))
            }
          />
          <label className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <span className="block text-sm font-semibold text-slate-950">Default page size</span>
            <span className="mt-2 block text-sm leading-6 text-slate-600">Rows to load per page.</span>
            <select
              value={preferences.defaultPageSize}
              onChange={(event) =>
                onUpdatePreferences((current) => ({
                  ...current,
                  defaultPageSize: Number(event.target.value),
                }))
              }
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size} rows
                </option>
              ))}
            </select>
          </label>
        </div>
      </AdminSectionCard>

      <AdminSectionCard
        label="Shortcuts"
        title="Keyboard help"
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-sm font-semibold text-slate-950">Cmd/Ctrl + K</p>
            <p className="mt-2 text-sm text-slate-600">Open the command palette for routes and quick location search.</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-sm font-semibold text-slate-950">Esc</p>
            <p className="mt-2 text-sm text-slate-600">Close the command palette, side panel, or mobile navigation.</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-sm font-semibold text-slate-950">Ctrl + Shift + 1</p>
            <p className="mt-2 text-sm text-slate-600">Jump into the admin workspace from the main map.</p>
          </div>
        </div>
      </AdminSectionCard>

      <AdminSectionCard
        label="Saved filters"
        title="Saved views"
      >
        {preferences.savedFilters.length === 0 ? (
          <AdminEmptyState
            title="No saved filters yet"
            message="Save a filter from Locations, Power Control, or Activity Log to reuse it later."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {preferences.savedFilters.map((filter) => (
              <SavedFilterCard
                key={filter.id}
                filter={filter}
                onRemove={() => onRemoveSavedFilter(filter.id)}
              />
            ))}
          </div>
        )}
      </AdminSectionCard>
    </div>
  );
}
