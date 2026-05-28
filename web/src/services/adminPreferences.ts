import type { ActivityTableQuery, LocationTableQuery, PowerScheduleQuery } from './adminApi';

export type SavedFilterPage = 'locations' | 'power' | 'activity';

export interface SavedFilterRecord {
  id: string;
  page: SavedFilterPage;
  name: string;
  query: Record<string, unknown>;
  createdAt: string;
}

export interface AdminPreferenceRecord {
  denseMode: boolean;
  defaultPageSize: number;
  autoRefresh: boolean;
  showKeyboardShortcuts: boolean;
  savedFilters: SavedFilterRecord[];
}

const STORAGE_KEY = 'wia-admin-preferences';

const defaultPreferences: AdminPreferenceRecord = {
  denseMode: true,
  defaultPageSize: 25,
  autoRefresh: false,
  showKeyboardShortcuts: true,
  savedFilters: [],
};

const parseStoredPreferences = (value: string | null): AdminPreferenceRecord => {
  if (!value) {
    return defaultPreferences;
  }

  try {
    const parsed = JSON.parse(value) as Partial<AdminPreferenceRecord>;

    return {
      denseMode: parsed.denseMode ?? defaultPreferences.denseMode,
      defaultPageSize: parsed.defaultPageSize ?? defaultPreferences.defaultPageSize,
      autoRefresh: parsed.autoRefresh ?? defaultPreferences.autoRefresh,
      showKeyboardShortcuts: parsed.showKeyboardShortcuts ?? defaultPreferences.showKeyboardShortcuts,
      savedFilters: Array.isArray(parsed.savedFilters) ? parsed.savedFilters : defaultPreferences.savedFilters,
    };
  } catch {
    return defaultPreferences;
  }
};

export const readAdminPreferences = (): AdminPreferenceRecord => {
  if (typeof window === 'undefined') {
    return defaultPreferences;
  }

  return parseStoredPreferences(window.localStorage.getItem(STORAGE_KEY));
};

export const writeAdminPreferences = (value: AdminPreferenceRecord): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
};

export const upsertSavedFilter = (
  page: SavedFilterPage,
  name: string,
  query: LocationTableQuery | ActivityTableQuery | PowerScheduleQuery | Record<string, unknown>
): AdminPreferenceRecord => {
  const current = readAdminPreferences();
  const nextRecord: SavedFilterRecord = {
    id: `${page}-${Date.now()}`,
    page,
    name: name.trim() || 'Saved view',
    query: { ...query },
    createdAt: new Date().toISOString(),
  };

  const nextPreferences = {
    ...current,
    savedFilters: [nextRecord, ...current.savedFilters.filter((filter) => filter.page !== page || filter.name !== nextRecord.name)],
  };

  writeAdminPreferences(nextPreferences);
  return nextPreferences;
};

export const removeSavedFilter = (filterId: string): AdminPreferenceRecord => {
  const current = readAdminPreferences();
  const nextPreferences = {
    ...current,
    savedFilters: current.savedFilters.filter((filter) => filter.id !== filterId),
  };

  writeAdminPreferences(nextPreferences);
  return nextPreferences;
};
