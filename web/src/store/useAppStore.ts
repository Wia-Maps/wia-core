import type { Feature, LineString } from 'geojson';
import { create } from 'zustand';
import type { GpsDiagnostics, GpsFixStatus } from '../core/gpsStatus';
import type { NavigationPose } from '../core/navigation/types';
import { clientConfig } from '../config/client';
import {
  normalizeFellowshipCode,
  type FellowshipBrandRecord,
} from '../core/fellowshipUtils';

/**
 * Types for the app store
 */
export interface LiveStatus {
  location_id: string;
  status: 'online' | 'offline' | 'maintenance';
  power_level?: number;
  last_updated: number;
}

export interface PowerSignal {
  locationId: string;
  powerStatus: boolean;
  reportedAt: number;
  reportedBy?: string | null;
}

export interface NotificationFeedEvent {
  id: string;
  locationId: string;
  locationName: string;
  module: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: string;
  createdAt: number;
}

export interface SelectedLocation {
  id: string;
  name: string;
  type: string;
  coordinates: [number, number];
  properties?: Record<string, any>;
  fellowshipFocusCode?: string | null;
  fellowshipServiceFocusKey?: string | null;
}

export interface SharedIntent {
  coordinates: [number, number];
  label: string;
  isSos: boolean;
}

export type LiveConnectionState = 'idle' | 'connecting' | 'connected' | 'offline' | 'rejected';

export interface StoredLocation {
  id: string;
  name: string;
  type: string;
  coordinates: [number, number];
  properties?: Record<string, any>;
  timestamp: number;
}

export interface PendingReport {
  id: string;
  location_id: string;
  type: string;
  description: string;
  timestamp: number;
  synced: boolean;
}

export interface RouteStep {
  id: string;
  instruction: string;
  distance_m: number;
  start_distance_m?: number;
  end_distance_m?: number;
  landmark_hint?: string | null;
}

export interface RouteFocusHighlight {
  id: string;
  path: [number, number][];
  arrowPath?: [number, number][];
  point: [number, number] | null;
  label: string | null;
  maneuver: 'straight' | 'right' | 'left' | 'sharp-right' | 'sharp-left' | 'uturn' | 'continue';
  bearingDeg: number | null;
  renderDurationMs?: number;
  expiresAt: number;
}

export type RouteAccessibilityMode = 'standard' | 'accessible';
export type UserMotionState = 'idle' | 'starting' | 'moving' | 'paused';
export type RouteEtaMode = 'planned' | 'live' | 'paused';
export type RouteTrackingStatus = 'on_route' | 'off_route';
export type RoutePreviewStatus = 'idle' | 'preparing' | 'ready' | 'error';
export type RouteKind = 'graph' | 'fallback_direct';

export interface UserMotion {
  speedMpsRaw: number | null;
  speedMpsInferred: number | null;
  speedMpsEffective: number | null;
  accuracyM: number | null;
  headingDeg: number | null;
  timestampMs: number | null;
  state: UserMotionState;
}

export interface RoutePreview {
  destination_id: string;
  mode: 'walking';
  path: [number, number][];
  route_kind?: RouteKind;
  fallback_reason?: string | null;
  distance_m: number;
  eta_min: number;
  eta_cost_m?: number;
  eta_baseline_min?: number;
  eta_live_min?: number;
  eta_mode?: RouteEtaMode;
  steps: RouteStep[];
  snapped_origin?: [number, number] | null;
  remaining_path?: [number, number][];
  remaining_distance_m?: number;
  eta_smoothed_min?: number;
  current_step_index?: number;
  distance_to_next_turn_m?: number;
  off_route_distance_m?: number;
  graph_node_ids?: string[];
  path_geojson?: Feature<LineString>;
  routing_mode?: RouteAccessibilityMode;
  origin_access_point?: [number, number] | null;
  destination_access_point?: [number, number] | null;
  origin_access_hint_path?: [number, number][] | null;
  warning_message?: string;
  tracking_status?: RouteTrackingStatus;
  tracking_message?: string | null;
  arrival_eligible?: boolean;
}

const toStoredLocation = (location: SelectedLocation): StoredLocation => ({
  id: location.id,
  name: location.name,
  type: location.type,
  coordinates: location.coordinates,
  properties: location.properties,
  timestamp: Date.now(),
});

const FAVOURITE_LOCATIONS_KEY = 'wia_favourite_locations';
const LEGACY_SAVED_LOCATIONS_KEY = 'wia_saved_locations';
const FAVOURITE_LOCATIONS_LIMIT = 5;
const RECENT_LOCATIONS_KEY = 'wia_recent_locations';
const RECENT_LOCATIONS_LIMIT = 5;
const NOTIFICATION_EVENTS_KEY = 'wia_notification_events';
const NOTIFICATION_EVENTS_LIMIT = 40;
const NOTIFICATION_FEED_SEEN_AT_KEY = 'wia_notification_feed_seen_at';

const DEFAULT_GPS_DIAGNOSTICS: GpsDiagnostics = {
  status: 'idle',
  permission: 'unknown',
  errorMessage: null,
  lastUpdatedAt: null,
};

const DEFAULT_USER_MOTION: UserMotion = {
  speedMpsRaw: null,
  speedMpsInferred: null,
  speedMpsEffective: null,
  accuracyM: null,
  headingDeg: null,
  timestampMs: null,
  state: 'idle',
};

const isPersistenceEnabled = (): boolean => {
  return clientConfig.offline.enabled && clientConfig.offline.persistence;
};

const isStoredLocation = (value: unknown): value is StoredLocation => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredLocation>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.type === 'string' &&
    Array.isArray(candidate.coordinates) &&
    candidate.coordinates.length === 2 &&
    typeof candidate.coordinates[0] === 'number' &&
    typeof candidate.coordinates[1] === 'number' &&
    typeof candidate.timestamp === 'number'
  );
};

const isNotificationFeedEvent = (value: unknown): value is NotificationFeedEvent => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<NotificationFeedEvent>;

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.locationId === 'string' &&
    typeof candidate.locationName === 'string' &&
    typeof candidate.module === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.createdAt === 'number'
  );
};

const readStoredLocations = (storageKeys: string[]): StoredLocation[] => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return [];
  }

  for (const storageKey of storageKeys) {
    try {
      const rawValue = window.localStorage.getItem(storageKey);
      if (!rawValue) {
        continue;
      }

      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }

      return parsed.filter(isStoredLocation);
    } catch {
      // Ignore unreadable storage buckets.
    }
  }

  return [];
};

const persistStoredLocations = (storageKey: string, locations: StoredLocation[]): void => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(locations));
  } catch {
    // Ignore storage write failures.
  }
};

const readNotificationEvents = (): NotificationFeedEvent[] => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(NOTIFICATION_EVENTS_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isNotificationFeedEvent).slice(0, NOTIFICATION_EVENTS_LIMIT);
  } catch {
    return [];
  }
};

const persistNotificationEvents = (events: NotificationFeedEvent[]): void => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return;
  }

  try {
    window.localStorage.setItem(NOTIFICATION_EVENTS_KEY, JSON.stringify(events));
  } catch {
    // Ignore storage write failures.
  }
};

const readNotificationFeedSeenAt = (): number => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return 0;
  }

  try {
    const rawValue = window.localStorage.getItem(NOTIFICATION_FEED_SEEN_AT_KEY);
    if (!rawValue) {
      return 0;
    }

    const parsed = Number.parseInt(rawValue, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
};

const persistNotificationFeedSeenAt = (timestamp: number): void => {
  if (typeof window === 'undefined' || !isPersistenceEnabled()) {
    return;
  }

  try {
    window.localStorage.setItem(NOTIFICATION_FEED_SEEN_AT_KEY, String(timestamp));
  } catch {
    // Ignore storage write failures.
  }
};

/**
 * Global app store using Zustand.
 */
interface AppStore {
  // UI State
  selectedLocation: SelectedLocation | null;
  bottomSheetOpen: boolean;

  // Live Status
  liveStatusMap: Map<string, LiveStatus>;
  powerSignalMap: Map<string, PowerSignal>;

  // Connectivity
  isOnline: boolean;

  // Reports
  pendingReports: PendingReport[];

  // Notifications
  notificationEvents: NotificationFeedEvent[];
  notificationFeedSeenAt: number;

  // User Location
  userLocation: [number, number] | null;
  navigationPose: NavigationPose | null;
  userMotion: UserMotion;
  gpsTrackingRequested: boolean;
  gpsRequestToken: number;
  gpsDiagnostics: GpsDiagnostics;

  // Navigation preview
  routePreviewActive: boolean;
  routePreview: RoutePreview | null;
  routePreviewStatus: RoutePreviewStatus;
  routePreviewError: string | null;
  routeFocusHighlight: RouteFocusHighlight | null;
  routeStepPreviewOpen: boolean;
  followUserLocation: boolean;
  routeAccessibilityMode: RouteAccessibilityMode;

  // Favourites + Recent
  favouriteLocations: StoredLocation[];
  recentLocations: StoredLocation[];

  // Filters
  activeFilters: string[];
  allCategories: string[];
  fellowshipBrandsByCode: Record<string, FellowshipBrandRecord>;
  sharedIntent: SharedIntent | null;
  activeLiveSessionId: string | null;
  isBroadcastingLive: boolean;
  liveConnectionState: LiveConnectionState;
  isSosPreparing: boolean;
  liveViewerCount: number;
  liveGpsAccuracy: number | null;


  // Actions
  selectLocation: (location: SelectedLocation) => void;
  refreshSelectedLocation: (location: SelectedLocation) => void;
  focusSelectedLocationFellowship: (
    fellowshipFocusCode: string | null,
    fellowshipServiceFocusKey?: string | null
  ) => void;
  deselectLocation: () => void;
  openBottomSheet: () => void;
  closeBottomSheet: () => void;

  updateLiveStatus: (statuses: LiveStatus[]) => void;
  getLiveStatus: (locationId: string) => LiveStatus | undefined;
  updatePowerSignals: (signals: PowerSignal[]) => void;
  getPowerSignal: (locationId: string) => PowerSignal | undefined;

  setOnline: (online: boolean) => void;

  addPendingReport: (report: Omit<PendingReport, 'id' | 'timestamp' | 'synced'>) => void;
  removePendingReport: (reportId: string) => void;
  markReportSynced: (reportId: string) => void;

  upsertNotificationEvents: (events: NotificationFeedEvent[]) => void;
  markNotificationFeedSeen: () => void;
  getUnreadNotificationCount: () => number;

  setUserLocation: (location: [number, number] | null) => void;
  setNavigationPose: (pose: NavigationPose | null) => void;
  setUserMotion: (patch: Partial<UserMotion>) => void;
  requestGpsAccess: () => void;
  setGpsDiagnostics: (patch: Partial<GpsDiagnostics>) => void;

  setRoutePreviewActive: (active: boolean) => void;
  setRoutePreview: (preview: RoutePreview | null) => void;
  setRoutePreviewStatus: (status: RoutePreviewStatus, error?: string | null) => void;
  setRouteFocusHighlight: (highlight: RouteFocusHighlight | null) => void;
  setRouteStepPreviewOpen: (open: boolean) => void;
  setFollowUserLocation: (follow: boolean) => void;
  setRouteAccessibilityMode: (mode: RouteAccessibilityMode) => void;
  clearRoutePreview: () => void;

  toggleFavouriteLocation: (location: SelectedLocation) => void;
  removeFavouriteLocation: (locationId: string) => void;
  isFavouriteLocation: (locationId: string) => boolean;
  clearRecentLocations: () => void;

  toggleFilter: (category: string) => void;
  setActiveFilters: (categories: string[]) => void;
  setAllCategories: (categories: string[]) => void;
  setFellowshipBrands: (brands: FellowshipBrandRecord[]) => void;
  isFilterActive: (category: string) => boolean;
  setSharedIntent: (intent: SharedIntent | null) => void;
  updateSharedIntentCoordinates: (coordinates: [number, number]) => void;
  setLiveTrackingStatus: (sessionId: string | null, isBroadcasting: boolean) => void;
  setLiveConnectionState: (state: LiveConnectionState) => void;
  setSosPreparing: (isPreparing: boolean) => void;
  setLiveViewerCount: (count: number) => void;
  setLiveGpsAccuracy: (accuracy: number | null) => void;
}


export const useAppStore = create<AppStore>((set, get) => ({
  // Initial state
  selectedLocation: null,
  bottomSheetOpen: false,
  liveStatusMap: new Map(),
  powerSignalMap: new Map(),
  isOnline: clientConfig.offline.enabled && typeof navigator !== 'undefined' ? navigator.onLine : true,
  pendingReports: [],
  notificationEvents: readNotificationEvents(),
  notificationFeedSeenAt: readNotificationFeedSeenAt(),
  userLocation: null,
  navigationPose: null,
  userMotion: DEFAULT_USER_MOTION,
  gpsTrackingRequested: false,
  gpsRequestToken: 0,
  gpsDiagnostics: DEFAULT_GPS_DIAGNOSTICS,
  routePreviewActive: false,
  routePreview: null,
  routePreviewStatus: 'idle',
  routePreviewError: null,
  routeFocusHighlight: null,
  routeStepPreviewOpen: false,
  followUserLocation: false,
  routeAccessibilityMode: 'standard',
  favouriteLocations: readStoredLocations([FAVOURITE_LOCATIONS_KEY, LEGACY_SAVED_LOCATIONS_KEY]).slice(
    0,
    FAVOURITE_LOCATIONS_LIMIT
  ),
  recentLocations: readStoredLocations([RECENT_LOCATIONS_KEY]).slice(0, RECENT_LOCATIONS_LIMIT),
  activeFilters: [],
  allCategories: [],
  fellowshipBrandsByCode: {},
  sharedIntent: null,
  activeLiveSessionId: null,
  isBroadcastingLive: false,
  liveConnectionState: 'idle',
  isSosPreparing: false,
  liveViewerCount: 0,
  liveGpsAccuracy: null,


  // Location actions
  selectLocation: (location) => {
    set((state) => {
      const recentWithoutCurrent = state.recentLocations.filter((item) => item.id !== location.id);
      const nextRecent = [toStoredLocation(location), ...recentWithoutCurrent].slice(0, RECENT_LOCATIONS_LIMIT);
      persistStoredLocations(RECENT_LOCATIONS_KEY, nextRecent);

      return {
        selectedLocation: location,
        bottomSheetOpen: false,
        recentLocations: nextRecent,
        routePreviewActive: false,
        routePreview: null,
        routePreviewStatus: 'idle',
        routePreviewError: null,
        routeFocusHighlight: null,
        routeStepPreviewOpen: false,
        followUserLocation: false,
      };
    });
  },

  refreshSelectedLocation: (location) => {
    set((state) => {
      if (!state.selectedLocation || state.selectedLocation.id !== location.id) {
        return state;
      }

      return {
        selectedLocation: {
          ...location,
          fellowshipFocusCode: location.fellowshipFocusCode ?? state.selectedLocation.fellowshipFocusCode ?? null,
          fellowshipServiceFocusKey:
            location.fellowshipServiceFocusKey ?? state.selectedLocation.fellowshipServiceFocusKey ?? null,
        },
      };
    });
  },

  focusSelectedLocationFellowship: (fellowshipFocusCode, fellowshipServiceFocusKey = null) => {
    set((state) => {
      if (!state.selectedLocation) {
        return state;
      }

      return {
        selectedLocation: {
          ...state.selectedLocation,
          fellowshipFocusCode,
          fellowshipServiceFocusKey,
        },
      };
    });
  },

  deselectLocation: () => {
    set({
      selectedLocation: null,
      bottomSheetOpen: false,
      routePreviewActive: false,
      routePreview: null,
      routePreviewStatus: 'idle',
      routePreviewError: null,
      routeFocusHighlight: null,
      followUserLocation: false,
    });
  },

  openBottomSheet: () => {
    set({ bottomSheetOpen: true });
  },

  closeBottomSheet: () => {
    set({ bottomSheetOpen: false });
  },

  // Live status actions
  updateLiveStatus: (statuses) => {
    const currentMap = get().liveStatusMap;
    const newMap = new Map(currentMap);

    statuses.forEach((status) => {
      newMap.set(status.location_id, status);
    });

    set({ liveStatusMap: newMap });
  },

  getLiveStatus: (locationId) => {
    return get().liveStatusMap.get(locationId);
  },

  updatePowerSignals: (signals) => {
    const currentMap = get().powerSignalMap;
    const newMap = new Map(currentMap);

    signals.forEach((signal) => {
      newMap.set(signal.locationId, signal);
    });

    set({ powerSignalMap: newMap });
  },

  getPowerSignal: (locationId) => {
    return get().powerSignalMap.get(locationId);
  },

  // Connectivity actions
  setOnline: (online) => {
    set({ isOnline: clientConfig.offline.enabled ? online : true });
  },

  // Report actions
  addPendingReport: (reportData) => {
    const report: PendingReport = {
      id: 'report_' + Date.now(),
      ...reportData,
      timestamp: Date.now(),
      synced: false,
    };

    set((state) => ({
      pendingReports: [...state.pendingReports, report],
    }));
  },

  removePendingReport: (reportId) => {
    set((state) => ({
      pendingReports: state.pendingReports.filter((report) => report.id !== reportId),
    }));
  },

  markReportSynced: (reportId) => {
    set((state) => ({
      pendingReports: state.pendingReports.map((report) =>
        report.id === reportId ? { ...report, synced: true } : report
      ),
    }));
  },

  upsertNotificationEvents: (events) => {
    set((state) => {
      const mergedEvents = new Map(state.notificationEvents.map((event) => [event.id, event]));

      events.forEach((event) => {
        const previousEvent = mergedEvents.get(event.id);

        mergedEvents.set(event.id, {
          ...(previousEvent ?? {}),
          ...event,
          data: event.data ?? previousEvent?.data ?? {},
        });
      });

      const nextEvents = Array.from(mergedEvents.values())
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, NOTIFICATION_EVENTS_LIMIT);

      persistNotificationEvents(nextEvents);

      return {
        notificationEvents: nextEvents,
      };
    });
  },

  markNotificationFeedSeen: () => {
    const seenAt = Date.now();
    persistNotificationFeedSeenAt(seenAt);
    set({ notificationFeedSeenAt: seenAt });
  },

  getUnreadNotificationCount: () => {
    const { notificationEvents, notificationFeedSeenAt } = get();

    return notificationEvents.filter((event) => event.createdAt > notificationFeedSeenAt).length;
  },

  // User location actions
  setUserLocation: (location) => {
    set({ userLocation: location });
  },

  setNavigationPose: (pose) => {
    set({ navigationPose: pose, userLocation: pose?.position ?? null });
  },

  setUserMotion: (patch) => {
    set((state) => {
      const nextUserMotion = {
        ...state.userMotion,
        ...patch,
      };

      const changed = (
        nextUserMotion.speedMpsRaw !== state.userMotion.speedMpsRaw ||
        nextUserMotion.speedMpsInferred !== state.userMotion.speedMpsInferred ||
        nextUserMotion.speedMpsEffective !== state.userMotion.speedMpsEffective ||
        nextUserMotion.accuracyM !== state.userMotion.accuracyM ||
        nextUserMotion.headingDeg !== state.userMotion.headingDeg ||
        nextUserMotion.timestampMs !== state.userMotion.timestampMs ||
        nextUserMotion.state !== state.userMotion.state
      );

      if (!changed) {
        return state;
      }

      return {
        userMotion: nextUserMotion,
      };
    });
  },

  requestGpsAccess: () => {
    set((state) => {
      const nextStatus: GpsFixStatus =
        state.gpsDiagnostics.status === 'unsupported' ? 'unsupported' : 'checking';

      return {
        gpsTrackingRequested: true,
        gpsRequestToken: state.gpsRequestToken + 1,
        gpsDiagnostics: {
          ...state.gpsDiagnostics,
          status: nextStatus,
          errorMessage: null,
          lastUpdatedAt: Date.now(),
        },
      };
    });
  },

  setGpsDiagnostics: (patch) => {
    set((state) => {
      const hasExplicitTimestamp = Object.prototype.hasOwnProperty.call(patch, 'lastUpdatedAt');

      return {
        gpsDiagnostics: {
          ...state.gpsDiagnostics,
          ...patch,
          lastUpdatedAt: hasExplicitTimestamp ? patch.lastUpdatedAt ?? null : Date.now(),
        },
      };
    });
  },

  // Navigation actions
  setRoutePreviewActive: (active) => {
    set((state) => ({
      routePreviewActive: active,
      routePreviewStatus:
        active && state.routePreviewStatus === 'idle'
          ? 'preparing'
          : active
            ? state.routePreviewStatus
            : 'idle',
      routePreviewError: active ? state.routePreviewError : null,
    }));
  },

  setRoutePreview: (preview) => {
    set({ routePreview: preview });
  },

  setRoutePreviewStatus: (status, error = null) => {
    set({
      routePreviewStatus: status,
      routePreviewError: error,
    });
  },

  setRouteFocusHighlight: (highlight) => {
    set({ routeFocusHighlight: highlight });
  },

  setRouteStepPreviewOpen: (open) => {
    set({ routeStepPreviewOpen: open });
  },

  setFollowUserLocation: (follow) => {
    set({ followUserLocation: follow });
  },

  setRouteAccessibilityMode: (mode) => {
    set({ routeAccessibilityMode: mode });
  },

  clearRoutePreview: () => {
    set({
      routePreviewActive: false,
      routePreview: null,
      routePreviewStatus: 'idle',
      routePreviewError: null,
      routeFocusHighlight: null,
      routeStepPreviewOpen: false,
      followUserLocation: false,
    });
  },

  // Favourites + Recent actions
  toggleFavouriteLocation: (location) => {
    set((state) => {
      const exists = state.favouriteLocations.some((item) => item.id === location.id);

      if (exists) {
        const nextFavourites = state.favouriteLocations.filter((item) => item.id !== location.id);
        persistStoredLocations(FAVOURITE_LOCATIONS_KEY, nextFavourites);
        return {
          favouriteLocations: nextFavourites,
        };
      }

      const favouritesWithoutCurrent = state.favouriteLocations.filter((item) => item.id !== location.id);
      const nextFavourites = [toStoredLocation(location), ...favouritesWithoutCurrent].slice(
        0,
        FAVOURITE_LOCATIONS_LIMIT
      );
      persistStoredLocations(FAVOURITE_LOCATIONS_KEY, nextFavourites);

      return { favouriteLocations: nextFavourites };
    });
  },

  removeFavouriteLocation: (locationId) => {
    set((state) => {
      const nextFavourites = state.favouriteLocations.filter((item) => item.id !== locationId);
      persistStoredLocations(FAVOURITE_LOCATIONS_KEY, nextFavourites);
      return {
        favouriteLocations: nextFavourites,
      };
    });
  },

  isFavouriteLocation: (locationId) => {
    return get().favouriteLocations.some((item) => item.id === locationId);
  },

  clearRecentLocations: () => {
    persistStoredLocations(RECENT_LOCATIONS_KEY, []);
    set({ recentLocations: [] });
  },

  // Filter actions
  toggleFilter: (category) => {
    const current = get().activeFilters;
    const newFilters = current.includes(category)
      ? current.filter((value) => value !== category)
      : [...current, category];
    set({ activeFilters: newFilters });
  },

  setActiveFilters: (categories) => {
    set({ activeFilters: categories });
  },

  setAllCategories: (categories) => {
    set({ allCategories: categories });
  },

  setFellowshipBrands: (brands) => {
    const fellowshipBrandsByCode = brands.reduce<Record<string, FellowshipBrandRecord>>((accumulator, brand) => {
      const code = normalizeFellowshipCode(brand?.code);

      if (!code) {
        return accumulator;
      }

      accumulator[code] = {
        ...brand,
        code,
      };

      return accumulator;
    }, {});

    set({ fellowshipBrandsByCode });
  },

  isFilterActive: (category) => {
    return get().activeFilters.includes(category);
  },

  setSharedIntent: (intent) => {
    set({ sharedIntent: intent });
  },

  updateSharedIntentCoordinates: (coordinates) => {
    set((state) => {
      if (!state.sharedIntent) return state;
      return {
        sharedIntent: {
          ...state.sharedIntent,
          coordinates,
        },
      };
    });
  },

  setLiveTrackingStatus: (sessionId, isBroadcasting) => {
    set({
      activeLiveSessionId: sessionId,
      isBroadcastingLive: isBroadcasting,
    });
  },

  setLiveConnectionState: (state) => {
    set({ liveConnectionState: state });
  },

  setSosPreparing: (isPreparing) => {
    set({ isSosPreparing: isPreparing });
  },

  setLiveViewerCount: (count) => {
    set({ liveViewerCount: count });
  },

  setLiveGpsAccuracy: (accuracy) => {
    set({ liveGpsAccuracy: accuracy });
  },

}));
