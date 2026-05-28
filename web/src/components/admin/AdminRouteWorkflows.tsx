import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, Position } from 'geojson';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { clientConfig } from '../../config/client';
import { useToast } from '../../context/ToastContext';
import { readCachedMapDataset, writeCachedMapDataset } from '../../services/mapDatasetCache';
import { publishMapDatasetUpdated } from '../../services/mapDatasetEvents';
import type { MapDatasetMutationRecord, MapDatasetRecord, MapFeatureCollection } from '../../services/mapDatasets';
import { fetchPublicMapDataset } from '../../services/mapDatasets';
import {
  approveAdminRouteCandidate,
  deleteAdminRouteRecordingDraft,
  fetchAdminRouteCandidates,
  rejectAdminRouteCandidate,
  saveAdminRouteRecordingDraft,
  submitAdminRouteRecording,
  updateAdminRouteCandidate,
  type RouteCandidateRecord,
} from '../../services/routeAdmin';
import {
  publishRoutingWeightOverlayUpdated,
  type RoutingWeightOverlayRecord,
  writeCachedRoutingWeightOverlay,
} from '../../services/routingWeights';
import { AdminEmptyState, AdminSectionCard, AdminStatusBadge, cx } from './AdminUi';
import {
  buildRouteCleanupMetadata,
  geometryToCleanupPoints,
  readRouteCleanupMetadata,
  type RouteCleanupIssue,
  type RouteCleanupMetadata,
} from './routeCleanup';
import {
  formatCompactDateTime,
  formatRelativeTime as formatSharedRelativeTime,
} from '../../utils/dateTime';

const RECORDING_DRAFT_KEY = 'wia_admin_route_recording_draft';
const SNAP_THRESHOLD_METERS = 12;

type RoutePoint = [number, number];
type BadgeTone = 'default' | 'info' | 'success' | 'danger' | 'warning';
type RouteBooleanField = keyof Pick<
  RouteCandidateRecord['routeProperties'],
  'accessible' | 'stairs' | 'ramp' | 'elevator'
>;

interface RouteCandidateReviewPanelProps {
  routingDataset: MapDatasetRecord<MapFeatureCollection> | null;
  locationsDataset: MapDatasetRecord<MapFeatureCollection> | null;
  mode: CandidateWorkspaceMode;
  focusCandidateId?: string | null;
  reloadToken?: number;
  onActivityChanged?: () => void;
  onRoutingPublished: (
    result: MapDatasetMutationRecord<MapFeatureCollection>,
    overlay: RoutingWeightOverlayRecord
  ) => Promise<void>;
}

interface RouteRecordingPanelProps {
  routingDataset: MapDatasetRecord<MapFeatureCollection> | null;
  locationsDataset: MapDatasetRecord<MapFeatureCollection> | null;
  onCandidateChanged?: () => void;
  onSubmittedToQueue?: (candidateId: string) => void;
  activeView: RouteRecordingView;
  onViewChange: (view: RouteRecordingView) => void;
}

interface AdminRouteWorkflowsPageProps {
  enabled: boolean;
  onWorkspaceRefresh: () => Promise<void>;
}

interface StoredRecordingDraft {
  draftId: string | null;
  title: string;
  routeName: string;
  points: RoutePoint[];
  routeProperties: Pick<RouteCandidateRecord['routeProperties'], RouteBooleanField>;
  recordingPhase: RecordingPhase;
  elapsedMs: number;
  accuracyTotalM: number;
  accuracySampleCount: number;
  lastAccuracyM: number | null;
  lastSampleAtMs: number | null;
  cleanupMetadata: RouteCleanupMetadata | null;
}

type RecordingPhase = 'draft' | 'recording' | 'paused' | 'stopped';
type GpsStatus = 'idle' | 'requesting' | 'ready' | 'unsupported' | 'denied' | 'error';
type CandidateWorkspaceMode = 'queue' | 'published';
type RouteLifecycleStage = 'capture' | 'draft' | 'queue' | 'live';
type QueueStatusFilter = 'all' | 'pending' | 'rejected';
type RouteWorkflowView = 'capture' | 'review' | 'drafts' | 'queue' | 'published';
type RouteRecordingView = Extract<RouteWorkflowView, 'capture' | 'review' | 'drafts'>;
interface WorkerSuggestionRecord {
  type: string;
  severity: 'default' | 'info' | 'warning' | 'danger';
  title: string;
  message: string;
  action: string;
  buildingIds: string[];
  buildingNames: string[];
}

interface RecentDraftLoadOptions {
  notifyOnError?: boolean;
}

const ROUTE_WORKFLOW_TABS: Array<{ id: RouteWorkflowView; label: string; hint: string }> = [
  { id: 'capture', label: 'Capture', hint: 'Record live' },
  { id: 'review', label: 'Review', hint: 'Clean up path' },
  { id: 'drafts', label: 'Drafts', hint: 'Reopen saved walks' },
  { id: 'queue', label: 'Queue', hint: 'Review pending' },
  { id: 'published', label: 'Published', hint: 'Live route history' },
];

const ROUTE_BOOLEAN_FIELDS: Array<{ key: RouteBooleanField; label: string }> = [
  { key: 'accessible', label: 'Accessible' },
  { key: 'stairs', label: 'Stairs' },
  { key: 'ramp', label: 'Ramp' },
  { key: 'elevator', label: 'Elevator' },
];

const DEFAULT_RECORDING_ROUTE_PROPERTIES: Pick<
  RouteCandidateRecord['routeProperties'],
  RouteBooleanField
> = {
  accessible: true,
  stairs: false,
  ramp: false,
  elevator: false,
};

const LIVE_RECORDING_MIN_POINT_DISTANCE_M = 1.5;
const LIVE_RECORDING_MAX_IDLE_INTERVAL_MS = 5000;
const MOVING_GLOW_HOLD_MS = 3200;
const LIVE_RECORDING_WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15000,
};
const PREVIEW_LOCATION_WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 15000,
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const toLatLng = (coordinate: RoutePoint): [number, number] => [coordinate[1], coordinate[0]];

const fromPosition = (position: Position): RoutePoint | null => {
  if (!Array.isArray(position) || position.length < 2) {
    return null;
  }

  const lng = Number(position[0]);
  const lat = Number(position[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return [lng, lat];
};

const toPosition = (coordinate: RoutePoint): Position => [coordinate[0], coordinate[1]];

const geometryToPoints = (geometry: RouteCandidateRecord['geometry'] | null | undefined): RoutePoint[] => {
  if (!geometry || geometry.type !== 'LineString') {
    return [];
  }

  return geometry.coordinates
    .map((position) => fromPosition(position))
    .filter((point): point is RoutePoint => Boolean(point));
};

const pointsToGeometry = (points: RoutePoint[]): RouteCandidateRecord['geometry'] => ({
  type: 'LineString',
  coordinates: points.map((point) => toPosition(point)),
});

const haversineMeters = (from: RoutePoint, to: RoutePoint): number => {
  return L.latLng(from[1], from[0]).distanceTo(L.latLng(to[1], to[0]));
};

const computePathDistance = (points: RoutePoint[]): number => {
  let total = 0;

  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(points[index - 1], points[index]);
  }

  return Math.round(total);
};

const simplifyPoints = (points: RoutePoint[], thresholdMeters = 2): RoutePoint[] => {
  if (points.length <= 2) {
    return points;
  }

  const simplified: RoutePoint[] = [points[0]];

  for (let index = 1; index < points.length - 1; index += 1) {
    if (haversineMeters(simplified[simplified.length - 1], points[index]) >= thresholdMeters) {
      simplified.push(points[index]);
    }
  }

  simplified.push(points[points.length - 1]);
  return simplified;
};

const extractRoutingNodePoints = (
  routingDataset: MapDatasetRecord<MapFeatureCollection> | null
): RoutePoint[] => {
  return (routingDataset?.collection.features ?? [])
    .map((feature) => {
      if (feature.geometry?.type !== 'Point') {
        return null;
      }

      return fromPosition((feature.geometry as Feature['geometry'] & { coordinates: Position }).coordinates);
    })
    .filter((point): point is RoutePoint => Boolean(point));
};

const positionsToRoutePoints = (positions: Position[]): RoutePoint[] => {
  return positions
    .map((position) => fromPosition(position))
    .filter((point): point is RoutePoint => Boolean(point));
};

const addLocationContextFeature = (
  layerGroup: L.LayerGroup,
  bounds: L.LatLngTuple[],
  feature: Feature
): void => {
  const geometry = feature.geometry;
  if (!geometry) {
    return;
  }

  if (geometry.type === 'Point') {
    const point = fromPosition(geometry.coordinates as Position);
    if (!point) {
      return;
    }

    bounds.push(toLatLng(point));
    L.circleMarker(toLatLng(point), {
      radius: 3,
      color: '#64748b',
      fillColor: '#f8fafc',
      fillOpacity: 0.88,
      opacity: 0.8,
      weight: 1.5,
    }).addTo(layerGroup);
    return;
  }

  if (geometry.type === 'MultiPoint') {
    positionsToRoutePoints(geometry.coordinates as Position[]).forEach((point) => {
      bounds.push(toLatLng(point));
      L.circleMarker(toLatLng(point), {
        radius: 3,
        color: '#64748b',
        fillColor: '#f8fafc',
        fillOpacity: 0.88,
        opacity: 0.8,
        weight: 1.5,
      }).addTo(layerGroup);
    });
    return;
  }

  if (geometry.type === 'LineString') {
    const line = positionsToRoutePoints(geometry.coordinates as Position[]);
    if (line.length < 2) {
      return;
    }

    line.forEach((point) => bounds.push(toLatLng(point)));
    L.polyline(line.map(toLatLng), {
      color: '#cbd5e1',
      weight: 2,
      opacity: 0.68,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(layerGroup);
    return;
  }

  if (geometry.type === 'MultiLineString') {
    (geometry.coordinates as Position[][]).forEach((segment) => {
      const line = positionsToRoutePoints(segment);
      if (line.length < 2) {
        return;
      }

      line.forEach((point) => bounds.push(toLatLng(point)));
      L.polyline(line.map(toLatLng), {
        color: '#cbd5e1',
        weight: 2,
        opacity: 0.68,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(layerGroup);
    });
    return;
  }

  if (geometry.type === 'Polygon') {
    const ring = positionsToRoutePoints((geometry.coordinates[0] ?? []) as Position[]);
    if (ring.length < 3) {
      return;
    }

    ring.forEach((point) => bounds.push(toLatLng(point)));
    L.polygon(ring.map(toLatLng), {
      color: '#94a3b8',
      weight: 1.5,
      opacity: 0.72,
      fillColor: '#e2e8f0',
      fillOpacity: 0.12,
    }).addTo(layerGroup);
    return;
  }

  if (geometry.type === 'MultiPolygon') {
    (geometry.coordinates as Position[][][]).forEach((polygon) => {
      const ring = positionsToRoutePoints((polygon[0] ?? []) as Position[]);
      if (ring.length < 3) {
        return;
      }

      ring.forEach((point) => bounds.push(toLatLng(point)));
      L.polygon(ring.map(toLatLng), {
        color: '#94a3b8',
        weight: 1.5,
        opacity: 0.72,
        fillColor: '#e2e8f0',
        fillOpacity: 0.12,
      }).addTo(layerGroup);
    });
  }
};

const snapEndpointsToDataset = (
  points: RoutePoint[],
  routingDataset: MapDatasetRecord<MapFeatureCollection> | null
): RoutePoint[] => {
  if (points.length < 2) {
    return points;
  }

  const nodes = extractRoutingNodePoints(routingDataset);
  if (nodes.length === 0) {
    return points;
  }

  const snapPoint = (point: RoutePoint): RoutePoint => {
    let best: { point: RoutePoint; distance: number } | null = null;

    for (const node of nodes) {
      const distance = haversineMeters(point, node);
      if (!best || distance < best.distance) {
        best = { point: node, distance };
      }
    }

    if (best && best.distance <= SNAP_THRESHOLD_METERS) {
      return best.point;
    }

    return point;
  };

  const nextPoints = [...points];
  nextPoints[0] = snapPoint(points[0]);
  nextPoints[nextPoints.length - 1] = snapPoint(points[nextPoints.length - 1]);
  return nextPoints;
};

const normalizeStoredRoutePoint = (value: unknown): RoutePoint | null => {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }

  return [lng, lat];
};

const normalizeRecordingPhase = (value: unknown): RecordingPhase => {
  if (value === 'recording' || value === 'paused' || value === 'stopped') {
    return value;
  }

  return 'draft';
};

const recordingPhaseLabel = (phase: RecordingPhase): string => {
  if (phase === 'recording') {
    return 'Recording';
  }

  if (phase === 'paused') {
    return 'Paused';
  }

  if (phase === 'stopped') {
    return 'Stopped';
  }

  return 'Ready';
};

const recordingPhaseTone = (phase: RecordingPhase): BadgeTone => {
  if (phase === 'recording') {
    return 'success';
  }

  if (phase === 'paused') {
    return 'warning';
  }

  if (phase === 'stopped') {
    return 'info';
  }

  return 'default';
};

const gpsStatusLabel = (status: GpsStatus): string => {
  if (status === 'requesting') {
    return 'Requesting GPS';
  }

  if (status === 'ready') {
    return 'GPS locked';
  }

  if (status === 'unsupported') {
    return 'GPS unavailable';
  }

  if (status === 'denied') {
    return 'GPS denied';
  }

  if (status === 'error') {
    return 'GPS error';
  }

  return 'GPS idle';
};

const gpsStatusTone = (status: GpsStatus): BadgeTone => {
  if (status === 'ready') {
    return 'success';
  }

  if (status === 'requesting') {
    return 'warning';
  }

  if (status === 'unsupported' || status === 'denied' || status === 'error') {
    return 'danger';
  }

  return 'default';
};

const toGeolocationErrorMessage = (error: GeolocationPositionError): string => {
  if (error.code === error.PERMISSION_DENIED) {
    return 'Location access is blocked for this browser tab.';
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    return 'Your device could not determine a reliable position.';
  }

  if (error.code === error.TIMEOUT) {
    return 'The GPS fix took too long. Move to a clearer area and try again.';
  }

  return error.message || 'Unable to read your current position.';
};

const readStoredRecordingDraft = (): StoredRecordingDraft | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(RECORDING_DRAFT_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const points = Array.isArray(parsed.points)
      ? parsed.points
          .map((point) => normalizeStoredRoutePoint(point))
          .filter((point): point is RoutePoint => Boolean(point))
      : [];

    const routeProperties = isRecord(parsed.routeProperties) ? parsed.routeProperties : {};

    return {
      draftId: typeof parsed.draftId === 'string' && parsed.draftId.trim() ? parsed.draftId.trim() : null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      routeName: typeof parsed.routeName === 'string' ? parsed.routeName : '',
      points,
      routeProperties: {
        accessible:
          typeof routeProperties.accessible === 'boolean'
            ? routeProperties.accessible
            : DEFAULT_RECORDING_ROUTE_PROPERTIES.accessible,
        stairs:
          typeof routeProperties.stairs === 'boolean'
            ? routeProperties.stairs
            : DEFAULT_RECORDING_ROUTE_PROPERTIES.stairs,
        ramp:
          typeof routeProperties.ramp === 'boolean'
            ? routeProperties.ramp
            : DEFAULT_RECORDING_ROUTE_PROPERTIES.ramp,
        elevator:
          typeof routeProperties.elevator === 'boolean'
            ? routeProperties.elevator
            : DEFAULT_RECORDING_ROUTE_PROPERTIES.elevator,
      },
      recordingPhase:
        normalizeRecordingPhase(parsed.recordingPhase) === 'recording'
          ? 'paused'
          : normalizeRecordingPhase(parsed.recordingPhase),
      elapsedMs: Math.max(0, Number(parsed.elapsedMs) || 0),
      accuracyTotalM: Math.max(0, Number(parsed.accuracyTotalM) || 0),
      accuracySampleCount: Math.max(0, Number(parsed.accuracySampleCount) || 0),
      lastAccuracyM:
        typeof parsed.lastAccuracyM === 'number' && Number.isFinite(parsed.lastAccuracyM)
          ? parsed.lastAccuracyM
          : null,
      lastSampleAtMs:
        typeof parsed.lastSampleAtMs === 'number' && Number.isFinite(parsed.lastSampleAtMs)
          ? parsed.lastSampleAtMs
          : null,
      cleanupMetadata: readRouteCleanupMetadata(parsed.cleanupMetadata),
    };
  } catch {
    return null;
  }
};

const writeStoredRecordingDraft = (draft: StoredRecordingDraft | null): void => {
  if (typeof window === 'undefined') {
    return;
  }

  if (!draft) {
    window.localStorage.removeItem(RECORDING_DRAFT_KEY);
    return;
  }

  const shouldPersist =
    Boolean(draft.draftId) ||
    draft.title.trim().length > 0 ||
    draft.routeName.trim().length > 0 ||
      draft.points.length > 0 ||
      draft.elapsedMs > 0 ||
      draft.recordingPhase !== 'draft';

  if (!shouldPersist) {
    window.localStorage.removeItem(RECORDING_DRAFT_KEY);
    return;
  }

  window.localStorage.setItem(RECORDING_DRAFT_KEY, JSON.stringify(draft));
};

const cloneCandidate = (candidate: RouteCandidateRecord): RouteCandidateRecord => {
  return JSON.parse(JSON.stringify(candidate)) as RouteCandidateRecord;
};

const candidateDisplayTitle = (
  candidate: Pick<RouteCandidateRecord, 'id' | 'title' | 'routeProperties'>
): string => {
  const title = candidate.title.trim();
  if (title) {
    return title;
  }

  const routeName = candidate.routeProperties.name.trim();
  if (routeName) {
    return routeName;
  }

  return `Candidate ${candidate.id.slice(-6)}`;
};

const formatMeters = (value: number): string => {
  const normalized = Math.max(0, Math.round(value || 0));
  if (normalized >= 1000) {
    return `${(normalized / 1000).toFixed(1)} km`;
  }

  return `${normalized} m`;
};

const formatDuration = (value: number): string => {
  const normalized = Math.max(0, Math.round(value || 0));
  if (normalized < 60) {
    return `${normalized}s`;
  }

  const minutes = Math.floor(normalized / 60);
  const seconds = normalized % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
};

const formatConfidence = (value: number): string => {
  return `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%`;
};

const formatTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return '-';
  }

  return formatCompactDateTime(value);
};

const statusTone = (status: RouteCandidateRecord['status']): BadgeTone => {
  if (status === 'approved') {
    return 'success';
  }

  if (status === 'rejected') {
    return 'danger';
  }

  if (status === 'pending') {
    return 'warning';
  }

  return 'info';
};

const sourceTone = (source: RouteCandidateRecord['source']): BadgeTone => {
  return source === 'analytics_discovery' ? 'info' : 'default';
};

const sourceLabel = (source: RouteCandidateRecord['source']): string => {
  return source === 'analytics_discovery' ? 'Discovered by analytics worker' : 'Recorded by admin';
};

const readWorkerSuggestions = (candidate: Pick<RouteCandidateRecord, 'metadata'> | null | undefined): WorkerSuggestionRecord[] => {
  const metadata = candidate?.metadata;
  if (!isRecord(metadata) || !Array.isArray(metadata.workerSuggestions)) {
    return [];
  }

  return metadata.workerSuggestions
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }

      return {
        type: typeof entry.type === 'string' ? entry.type : 'unknown',
        severity:
          entry.severity === 'danger' || entry.severity === 'info' || entry.severity === 'default'
            ? entry.severity
            : 'warning',
        title: typeof entry.title === 'string' ? entry.title : 'Needs review',
        message: typeof entry.message === 'string' ? entry.message : '',
        action: typeof entry.action === 'string' ? entry.action : '',
        buildingIds: Array.isArray(entry.buildingIds) ? entry.buildingIds.filter((value): value is string => typeof value === 'string') : [],
        buildingNames: Array.isArray(entry.buildingNames)
          ? entry.buildingNames.filter((value): value is string => typeof value === 'string')
          : [],
      } satisfies WorkerSuggestionRecord;
    })
    .filter((entry): entry is WorkerSuggestionRecord => Boolean(entry));
};

const readBuildingCrossingCount = (candidate: Pick<RouteCandidateRecord, 'metadata'> | null | undefined): number => {
  const metadata = candidate?.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.buildingCrossings)) {
    return 0;
  }

  return Math.max(0, Number(metadata.buildingCrossings.count) || 0);
};

const readCleanupMetadata = (candidate: Pick<RouteCandidateRecord, 'metadata'> | null | undefined): RouteCleanupMetadata | null => {
  return readRouteCleanupMetadata(candidate?.metadata);
};

const readPendingCleanupIssues = (candidate: Pick<RouteCandidateRecord, 'metadata'> | null | undefined): RouteCleanupIssue[] => {
  return (readCleanupMetadata(candidate)?.issues ?? []).filter((issue) => issue.status === 'pending');
};

const candidateNeedsWorkerEdit = (candidate: Pick<RouteCandidateRecord, 'metadata'> | null | undefined): boolean => {
  const metadata = candidate?.metadata;
  return (
    (isRecord(metadata) && metadata.reviewRecommendation === 'edit_before_approval') ||
    readWorkerSuggestions(candidate).length > 0 ||
    readBuildingCrossingCount(candidate) > 0 ||
    readPendingCleanupIssues(candidate).length > 0
  );
};

const lifecycleStageLabel = (stage: RouteLifecycleStage): string => {
  if (stage === 'capture') {
    return 'Capture';
  }

  if (stage === 'draft') {
    return 'Draft';
  }

  if (stage === 'queue') {
    return 'Queue';
  }

  return 'Live';
};

const lifecycleStageIndex = (stage: RouteLifecycleStage): number => {
  if (stage === 'capture') {
    return 0;
  }

  if (stage === 'draft') {
    return 1;
  }

  if (stage === 'queue') {
    return 2;
  }

  return 3;
};

const candidateLifecycleStage = (candidate: Pick<RouteCandidateRecord, 'status'>): RouteLifecycleStage => {
  if (candidate.status === 'approved') {
    return 'live';
  }

  if (candidate.status === 'pending' || candidate.status === 'rejected') {
    return 'queue';
  }

  return 'draft';
};

const formatActorLabel = (
  actor:
    | {
        adminId: string | null;
        email: string | null;
      }
    | null
    | undefined
): string => {
  return actor?.email || actor?.adminId || '-';
};

const RouteLifecycleStrip: React.FC<{ stage: RouteLifecycleStage; className?: string; compact?: boolean; noWrap?: boolean }> = ({
  stage,
  className,
  compact = false,
  noWrap = false,
}) => {
  const activeIndex = lifecycleStageIndex(stage);
  const stages: RouteLifecycleStage[] = ['capture', 'draft', 'queue', 'live'];

  return (
    <div
      className={cx(
        'flex items-center',
        noWrap ? 'gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden' : 'flex-wrap gap-2',
        className
      )}
    >
      {stages.map((item, index) => {
        const active = item === stage;
        const complete = index < activeIndex;

        return (
          <div key={item} className={cx('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
            <span
              className={cx(
                compact
                  ? 'rounded-full border px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.14em]'
                  : 'rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]',
                active
                  ? 'border-sky-300 bg-sky-50 text-sky-900'
                  : complete
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-slate-50 text-slate-500'
              )}
            >
              {lifecycleStageLabel(item)}
            </span>
            {index < stages.length - 1 ? <span className={compact ? 'text-[10px] text-slate-300' : 'text-xs text-slate-300'}>{'->'}</span> : null}
          </div>
        );
      })}
    </div>
  );
};

const cleanupIssueLabel = (type: RouteCleanupIssue['type']): string => {
  return type === 'duplicate_overlap' ? 'Overlap cleanup' : 'Loop straightening';
};

const cleanupIssueMetricSummary = (issue: RouteCleanupIssue): string => {
  if (issue.type === 'duplicate_overlap') {
    return `${formatMeters(issue.metrics.pathDistanceM || 0)} over ${formatMeters(issue.metrics.displacementM || 0)} displacement`;
  }

  return `${formatMeters(issue.metrics.diameterM || 0)} loop diameter, ${Math.round(issue.metrics.turnDegrees || 0)}° turn`;
};

const RouteCleanupAssistantCard: React.FC<{
  metadata: RouteCleanupMetadata | null;
  onApplyIssue: (issue: RouteCleanupIssue) => void;
  onDismissIssue: (issue: RouteCleanupIssue) => void;
  onPreviewIssue?: (issue: RouteCleanupIssue) => void;
  previewIssueIds?: string[];
  onApplyAllSafe?: () => void;
  compact?: boolean;
}> = ({
  metadata,
  onApplyIssue,
  onDismissIssue,
  onPreviewIssue,
  previewIssueIds = [],
  onApplyAllSafe,
  compact = false,
}) => {
  const issues = metadata?.issues ?? [];
  const pendingIssues = issues.filter((issue) => issue.status === 'pending');
  const safeIssues = pendingIssues.filter((issue) => issue.confidence >= 0.82);

  if (issues.length === 0) {
    return (
      <div className="rounded-[24px] border border-emerald-200 bg-emerald-50 px-4 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-800">AI route cleanup</p>
        <p className="mt-2 text-sm leading-6 text-emerald-950">
          No doubled paths or circular GPS jitter stand out in this route right now.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[24px] border border-sky-200 bg-sky-50 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-800">AI route cleanup</p>
          <p className="mt-2 text-sm leading-6 text-sky-950">
            Review suggested fixes for doubled sections or circular GPS drift before publishing this route.
          </p>
        </div>
        {onApplyAllSafe && safeIssues.length > 0 ? (
          <button
            type="button"
            onClick={onApplyAllSafe}
            className="rounded-full border border-sky-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-900 transition hover:border-sky-400 hover:bg-sky-100"
          >
            Apply safe fixes
          </button>
        ) : null}
      </div>

      <div className={cx('mt-4 space-y-3', compact ? 'text-sm' : undefined)}>
        {issues.map((issue) => {
          const isPreviewing = previewIssueIds.includes(issue.id);
          const toneClasses =
            issue.status === 'accepted'
              ? 'border-emerald-200 bg-emerald-50'
              : issue.status === 'dismissed'
                ? 'border-slate-200 bg-slate-50'
                : 'border-sky-200 bg-white/80';

          return (
            <div
              key={issue.id}
              className={cx(
                'rounded-2xl border px-3 py-3',
                toneClasses,
                isPreviewing ? 'ring-2 ring-sky-300 ring-offset-2 ring-offset-sky-50' : undefined
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <AdminStatusBadge tone={issue.status === 'accepted' ? 'success' : issue.status === 'dismissed' ? 'default' : 'info'}>
                  {issue.status}
                </AdminStatusBadge>
                <AdminStatusBadge>{cleanupIssueLabel(issue.type)}</AdminStatusBadge>
                <AdminStatusBadge>{Math.round(issue.confidence * 100)}% confidence</AdminStatusBadge>
                <AdminStatusBadge tone={issue.source === 'worker' ? 'info' : 'default'}>
                  {issue.source === 'worker' ? 'Worker detected' : 'Editor detected'}
                </AdminStatusBadge>
              </div>
              <p className="mt-3 font-semibold text-slate-950">{issue.title}</p>
              {issue.message ? <p className="mt-1 text-sm leading-6 text-slate-700">{issue.message}</p> : null}
              <p className="mt-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                {cleanupIssueMetricSummary(issue)}
              </p>
              {issue.status === 'pending' ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {onPreviewIssue ? (
                    <button
                      type="button"
                      onClick={() => onPreviewIssue(issue)}
                      className={cx(
                        'rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition',
                        isPreviewing
                          ? 'border-sky-400 bg-sky-100 text-sky-950 hover:border-sky-500 hover:bg-sky-200'
                          : 'border-sky-300 bg-white text-sky-900 hover:border-sky-400 hover:bg-sky-100'
                      )}
                    >
                      {isPreviewing ? 'Hide preview' : 'Preview on map'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onApplyIssue(issue)}
                    className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800"
                  >
                    Accept fix
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismissIssue(issue)}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                  >
                    Dismiss
                  </button>
                </div>
              ) : issue.status === 'accepted' ? (
                <p className="mt-3 text-sm text-emerald-900">Accepted. The cleaned geometry will stay attached to this route when you save.</p>
              ) : (
                <p className="mt-3 text-sm text-slate-600">Dismissed. This suggestion is preserved for audit, but it will not block review.</p>
              )}
              {issue.status === 'pending' && isPreviewing ? (
                <p className="mt-3 text-sm text-sky-900">
                  Map preview is showing this suggested geometry in blue while the current path stays visible underneath.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const normalizeHeading = (heading: number): number => {
  const normalized = heading % 360;
  return normalized >= 0 ? normalized : normalized + 360;
};

const calculateBearing = (from: RoutePoint, to: RoutePoint): number => {
  const fromLat = (from[1] * Math.PI) / 180;
  const toLat = (to[1] * Math.PI) / 180;
  const deltaLng = ((to[0] - from[0]) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
};

const hasMoved = (from: RoutePoint | null, to: RoutePoint): boolean => {
  if (!from) {
    return false;
  }

  const latDelta = Math.abs(from[1] - to[1]);
  const lngDelta = Math.abs(from[0] - to[0]);

  return latDelta > 0.00001 || lngDelta > 0.00001;
};

const detectMovement = (
  previousLocation: RoutePoint | null,
  currentLocation: RoutePoint,
  speedMps: number | null
): boolean => {
  if (typeof speedMps === 'number' && Number.isFinite(speedMps) && speedMps >= 0.35) {
    return true;
  }

  if (!previousLocation) {
    return false;
  }

  return haversineMeters(previousLocation, currentLocation) >= 0.9;
};

const resolveHeading = (
  rawHeading: number | null,
  previousLocation: RoutePoint | null,
  currentLocation: RoutePoint,
  previousHeading: number
): number => {
  if (typeof rawHeading === 'number' && Number.isFinite(rawHeading) && rawHeading >= 0) {
    return normalizeHeading(rawHeading);
  }

  if (hasMoved(previousLocation, currentLocation) && previousLocation) {
    return calculateBearing(previousLocation, currentLocation);
  }

  return previousHeading;
};

const createHeadingIcon = (heading: number, isMoving: boolean): L.DivIcon => {
  const movingGlowHtml = isMoving
    ? '<span class="user-heading-moving-glow"></span><span class="user-heading-moving-glow user-heading-moving-glow-delay"></span><span class="user-heading-moving-glow user-heading-moving-glow-delay-2"></span>'
    : '';

  return L.divIcon({
    className: 'user-heading-icon',
    html: `<div class="user-heading-marker" style="--heading: ${heading.toFixed(1)}deg;">${movingGlowHtml}<span class="user-heading-disc"></span><span class="user-heading-arrow"></span></div>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  });
};

const MobileImmersiveToggleIcon: React.FC<{ immersive: boolean }> = ({ immersive }) => {
  return immersive ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M6 12h12" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M8 5H5v3" />
      <path d="M16 5h3v3" />
      <path d="M19 16v3h-3" />
      <path d="M8 19H5v-3" />
    </svg>
  );
};

const MetricCard: React.FC<{ label: string; value: string | number; hint?: string }> = ({
  label,
  value,
  hint,
}) => {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-950">{value}</p>
      {hint ? <p className="mt-2 text-sm text-slate-600">{hint}</p> : null}
    </div>
  );
};

const RoutePreviewMap: React.FC<{
  routingDataset: MapDatasetRecord<MapFeatureCollection> | null;
  locationsDataset: MapDatasetRecord<MapFeatureCollection> | null;
  candidates: RouteCandidateRecord[];
  selectedCandidateId?: string | null;
  draftGeometry?: RouteCandidateRecord['geometry'] | null;
  previewGeometries?: RouteCandidateRecord['geometry'][];
  draftPoints?: RoutePoint[];
  livePoint?: RoutePoint | null;
  liveAccuracyM?: number | null;
  liveHeadingDeg?: number | null;
  liveSpeedMps?: number | null;
  editable?: boolean;
  onAppendPoint?: (point: RoutePoint) => void;
  className?: string;
  mapClassName?: string;
  showLegend?: boolean;
  autoFrameKey?: string | null;
}> = ({
  routingDataset,
  locationsDataset,
  candidates,
  selectedCandidateId = null,
  draftGeometry = null,
  previewGeometries = [],
  draftPoints = [],
  livePoint = null,
  liveAccuracyM = null,
  liveHeadingDeg = null,
  liveSpeedMps = null,
  editable = false,
  onAppendPoint,
  className,
  mapClassName,
  showLegend = true,
  autoFrameKey = null,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const previousLivePointRef = useRef<RoutePoint | null>(null);
  const liveHeadingRef = useRef(0);
  const movingUntilRef = useRef(0);
  const autoFrameKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView(clientConfig.map.center, clientConfig.map.zoom);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: clientConfig.map.maxZoom,
    }).addTo(map);

    const layerGroup = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = layerGroup;

    const handleClick = (event: L.LeafletMouseEvent): void => {
      if (!editable || !onAppendPoint) {
        return;
      }

      onAppendPoint([event.latlng.lng, event.latlng.lat]);
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
      layerGroup.clearLayers();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, [editable, onAppendPoint]);

  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;

    if (!map || !layerGroup) {
      return;
    }

    layerGroup.clearLayers();
    const bounds: L.LatLngTuple[] = [];

    (locationsDataset?.collection.features ?? []).forEach((feature) => {
      addLocationContextFeature(layerGroup, bounds, feature as Feature);
    });

    (routingDataset?.collection.features ?? []).forEach((feature) => {
      if (feature.geometry?.type !== 'LineString') {
        return;
      }

      const coordinates = feature.geometry.coordinates
        .map((position) => fromPosition(position as Position))
        .filter((point): point is RoutePoint => Boolean(point))
        .map((point) => {
          bounds.push(toLatLng(point));
          return toLatLng(point);
        });

      if (coordinates.length >= 2) {
        L.polyline(coordinates, {
          color: '#94a3b8',
          weight: 3,
          opacity: 0.5,
        }).addTo(layerGroup);
      }
    });

    candidates.forEach((candidate) => {
      const candidatePoints = geometryToPoints(candidate.geometry);
      if (candidatePoints.length < 2) {
        return;
      }

      const isSelected = selectedCandidateId === candidate.id;
      const tone =
        candidate.status === 'approved' ? '#0f766e' : candidate.status === 'rejected' ? '#dc2626' : '#ea580c';

      candidatePoints.forEach((point) => bounds.push(toLatLng(point)));
      L.polyline(candidatePoints.map(toLatLng), {
        color: tone,
        weight: isSelected ? 6 : 4,
        opacity: isSelected ? 0.95 : 0.75,
        dashArray:
          candidate.status === 'pending' || candidate.status === 'draft' ? '10 8' : undefined,
      }).addTo(layerGroup);
    });

    const resolvedDraftPoints = draftPoints.length > 0 ? draftPoints : geometryToPoints(draftGeometry);
    if (resolvedDraftPoints.length > 0) {
      resolvedDraftPoints.forEach((point) => bounds.push(toLatLng(point)));

      L.circleMarker(toLatLng(resolvedDraftPoints[0]), {
        radius: 6,
        color: '#15803d',
        fillColor: '#22c55e',
        fillOpacity: 0.95,
        weight: 2,
      }).addTo(layerGroup);

      if (resolvedDraftPoints.length > 1) {
        L.circleMarker(toLatLng(resolvedDraftPoints[resolvedDraftPoints.length - 1]), {
          radius: 6,
          color: '#b45309',
          fillColor: '#fb923c',
          fillOpacity: 0.95,
          weight: 2,
        }).addTo(layerGroup);
      }
    }

    if (resolvedDraftPoints.length >= 2) {
      L.polyline(resolvedDraftPoints.map(toLatLng), {
        color: '#f97316',
        weight: 6,
        opacity: 0.95,
        dashArray: '8 8',
      }).addTo(layerGroup);
    }

    previewGeometries.forEach((geometry) => {
      const previewPoints = geometryToPoints(geometry);
      if (previewPoints.length > 0) {
        previewPoints.forEach((point) => bounds.push(toLatLng(point)));
      }

      if (previewPoints.length >= 2) {
        L.polyline(previewPoints.map(toLatLng), {
          color: '#e0f2fe',
          weight: 11,
          opacity: 0.55,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layerGroup);

        L.polyline(previewPoints.map(toLatLng), {
          color: '#0284c7',
          weight: 6,
          opacity: 0.96,
          dashArray: '12 10',
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layerGroup);

        L.circleMarker(toLatLng(previewPoints[0]), {
          radius: 5,
          color: '#0369a1',
          fillColor: '#38bdf8',
          fillOpacity: 0.95,
          weight: 2,
        }).addTo(layerGroup);

        L.circleMarker(toLatLng(previewPoints[previewPoints.length - 1]), {
          radius: 5,
          color: '#075985',
          fillColor: '#7dd3fc',
          fillOpacity: 0.95,
          weight: 2,
        }).addTo(layerGroup);
      }
    });

    if (livePoint) {
      bounds.push(toLatLng(livePoint));
      const previousLivePoint = previousLivePointRef.current;
      const resolvedHeading = resolveHeading(liveHeadingDeg, previousLivePoint, livePoint, liveHeadingRef.current);
      const movementDetected = detectMovement(previousLivePoint, livePoint, liveSpeedMps);

      if (movementDetected) {
        movingUntilRef.current = Date.now() + MOVING_GLOW_HOLD_MS;
      }

      liveHeadingRef.current = resolvedHeading;
      previousLivePointRef.current = livePoint;

      if (typeof liveAccuracyM === 'number' && Number.isFinite(liveAccuracyM) && liveAccuracyM > 0) {
        L.circle(toLatLng(livePoint), {
          radius: liveAccuracyM,
          color: '#38bdf8',
          fillColor: '#7dd3fc',
          fillOpacity: 0.12,
          weight: 1.5,
        }).addTo(layerGroup);
      }

      L.marker(toLatLng(livePoint), {
        icon: createHeadingIcon(resolvedHeading, Date.now() < movingUntilRef.current),
        interactive: false,
        keyboard: false,
        zIndexOffset: 2200,
      }).addTo(layerGroup);
    } else {
      previousLivePointRef.current = null;
      liveHeadingRef.current = 0;
      movingUntilRef.current = 0;
    }

    if (autoFrameKey && autoFrameKeyRef.current !== autoFrameKey) {
      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [20, 20] });
      } else if (bounds.length === 1) {
        map.setView(bounds[0], 17);
      } else {
        map.setView(clientConfig.map.center, clientConfig.map.zoom);
      }
      autoFrameKeyRef.current = autoFrameKey;
    }
  }, [
    autoFrameKey,
    candidates,
    draftGeometry,
    draftPoints,
    liveAccuracyM,
    liveHeadingDeg,
    livePoint,
    liveSpeedMps,
    locationsDataset,
    previewGeometries,
    routingDataset,
    selectedCandidateId,
  ]);

  return (
    <div className={cx('rounded-[28px] border border-slate-200 bg-white p-4', className)}>
      {showLegend ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {locationsDataset ? <AdminStatusBadge>Locations context</AdminStatusBadge> : null}
          <AdminStatusBadge tone="info">Approved graph</AdminStatusBadge>
          {candidates.length > 0 ? <AdminStatusBadge tone="warning">Candidate routes</AdminStatusBadge> : null}
          {draftPoints.length > 0 || draftGeometry ? <AdminStatusBadge tone="warning">Recorded path</AdminStatusBadge> : null}
          {previewGeometries.length > 0 ? <AdminStatusBadge tone="info">Fix preview{previewGeometries.length > 1 ? 's' : ''}</AdminStatusBadge> : null}
          {livePoint ? <AdminStatusBadge tone="success">Current location</AdminStatusBadge> : null}
          {editable ? <AdminStatusBadge>Click map to append correction points</AdminStatusBadge> : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        className={cx('h-[360px] w-full overflow-hidden rounded-[24px] border border-slate-200', mapClassName)}
      />
    </div>
  );
};

export const AdminRouteCandidateReviewPanel: React.FC<RouteCandidateReviewPanelProps> = ({
  routingDataset,
  locationsDataset,
  mode,
  focusCandidateId = null,
  reloadToken = 0,
  onActivityChanged,
  onRoutingPublished,
}) => {
  const { showError, showSuccess, showWarning } = useToast();
  const isPublishedMode = mode === 'published';
  const [candidates, setCandidates] = useState<RouteCandidateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftCandidate, setDraftCandidate] = useState<RouteCandidateRecord | null>(null);
  const [statusFilter, setStatusFilter] = useState<QueueStatusFilter>('pending');
  const [sourceFilter, setSourceFilter] = useState<'all' | RouteCandidateRecord['source']>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [cleanupPersistedIssues, setCleanupPersistedIssues] = useState<RouteCleanupIssue[]>([]);
  const [cleanupOriginalGeometry, setCleanupOriginalGeometry] = useState<RouteCandidateRecord['geometry'] | null>(null);
  const [previewCleanupIssueIds, setPreviewCleanupIssueIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [highlightedCandidateId, setHighlightedCandidateId] = useState<string | null>(null);
  const candidateItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (!focusCandidateId || isPublishedMode) {
      return;
    }

    setStatusFilter('pending');
    setSourceFilter('all');
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setSelectedId(focusCandidateId);
    setHighlightedCandidateId(focusCandidateId);
  }, [focusCandidateId, isPublishedMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setDebouncedSearchQuery(searchQuery);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchQuery]);

  const loadCandidates = useCallback(
    async (preferredCandidateId?: string | null): Promise<void> => {
      setLoading(true);
      try {
        const response = await fetchAdminRouteCandidates({
          status: isPublishedMode ? 'approved' : statusFilter === 'all' ? '' : statusFilter,
          source: sourceFilter === 'all' ? '' : sourceFilter,
          search: debouncedSearchQuery.trim(),
          pageSize: 100,
        });

        setCandidates(response.items);
        setSelectedId((current) => {
          const preferred = preferredCandidateId ?? current;
          if (preferred && response.items.some((item) => item.id === preferred)) {
            return preferred;
          }

          return response.items[0]?.id ?? null;
        });
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Unable to load route candidates.', {
          title: isPublishedMode ? 'Published routes' : 'Route queue',
          dedupeKey: `route-candidates-load-${mode}`,
        });
      } finally {
        setLoading(false);
      }
    },
    [debouncedSearchQuery, isPublishedMode, mode, showError, sourceFilter, statusFilter]
  );

  useEffect(() => {
    void loadCandidates(!isPublishedMode && focusCandidateId ? focusCandidateId : null);
  }, [focusCandidateId, isPublishedMode, loadCandidates, reloadToken]);

  useEffect(() => {
    const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null;
    setDraftCandidate(selected ? cloneCandidate(selected) : null);
    setReviewNotes(selected?.review?.notes ?? '');
    setRejectionReason(selected?.review?.rejectionReason ?? '');
    const cleanupMetadata = readCleanupMetadata(selected);
    setCleanupPersistedIssues(cleanupMetadata?.issues ?? []);
    setCleanupOriginalGeometry(cleanupMetadata?.originalGeometry ?? null);
    setPreviewCleanupIssueIds([]);
  }, [candidates, selectedId]);

  const selectedCandidate = useMemo(() => {
    return candidates.find((candidate) => candidate.id === selectedId) ?? null;
  }, [candidates, selectedId]);

  const workerSuggestions = useMemo(() => readWorkerSuggestions(draftCandidate), [draftCandidate]);
  const buildingCrossingCount = useMemo(() => readBuildingCrossingCount(draftCandidate), [draftCandidate]);
  const baseNeedsWorkerEdit = useMemo(() => candidateNeedsWorkerEdit(draftCandidate), [draftCandidate]);

  useEffect(() => {
    if (!highlightedCandidateId || typeof window === 'undefined') {
      return;
    }

    const candidateNode = candidateItemRefs.current[highlightedCandidateId];
    candidateNode?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timeoutId = window.setTimeout(() => {
      setHighlightedCandidateId((current) => (current === highlightedCandidateId ? null : current));
    }, 2400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [highlightedCandidateId]);

  const candidateCounts = useMemo(() => {
    return candidates.reduce(
      (accumulator, candidate) => {
        accumulator[candidate.status] += 1;
        return accumulator;
      },
      {
        draft: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
      } as Record<RouteCandidateRecord['status'], number>
    );
  }, [candidates]);

  const draftPoints = useMemo(() => geometryToPoints(draftCandidate?.geometry), [draftCandidate?.geometry]);

  const geometryDirty = useMemo(() => {
    if (!selectedCandidate || !draftCandidate) {
      return false;
    }

    return (
      JSON.stringify(selectedCandidate.geometry.coordinates) !==
      JSON.stringify(draftCandidate.geometry.coordinates)
    );
  }, [draftCandidate, selectedCandidate]);

  const cleanupMetadata = useMemo(() => {
    return buildRouteCleanupMetadata(geometryToCleanupPoints(draftCandidate?.geometry ?? null), {
      source: 'editor',
      originalGeometry: cleanupOriginalGeometry,
      persistedIssues: cleanupPersistedIssues,
    });
  }, [cleanupOriginalGeometry, cleanupPersistedIssues, draftCandidate?.geometry]);

  const pendingCleanupIssues = useMemo(() => {
    return (cleanupMetadata?.issues ?? []).filter((issue) => issue.status === 'pending');
  }, [cleanupMetadata]);

  const safeCleanupIssues = useMemo(() => {
    return pendingCleanupIssues.filter((issue) => issue.confidence >= 0.82);
  }, [pendingCleanupIssues]);

  const previewCleanupIssues = useMemo(() => {
    if (previewCleanupIssueIds.length === 0) {
      return [];
    }

    const selectedPreviewIds = new Set(previewCleanupIssueIds);
    return (cleanupMetadata?.issues ?? []).filter(
      (issue) => issue.status === 'pending' && selectedPreviewIds.has(issue.id)
    );
  }, [cleanupMetadata, previewCleanupIssueIds]);

  const needsWorkerEdit = useMemo(() => {
    return baseNeedsWorkerEdit || pendingCleanupIssues.length > 0;
  }, [baseNeedsWorkerEdit, pendingCleanupIssues.length]);

  const selectedDistanceM = useMemo(() => computePathDistance(draftPoints), [draftPoints]);

  const selectedConfidencePercent = useMemo(() => {
    return draftCandidate ? Math.round((draftCandidate.confidence || 0) * 100) : 0;
  }, [draftCandidate]);

  const updateDraftGeometry = (points: RoutePoint[]): void => {
    if (!draftCandidate || points.length < 2) {
      return;
    }

    setDraftCandidate({
      ...draftCandidate,
      geometry: pointsToGeometry(points),
      averageDistanceM: computePathDistance(points),
    });
  };

  const updateCleanupIssueStatus = useCallback((issue: RouteCleanupIssue, status: RouteCleanupIssue['status']): void => {
    setCleanupPersistedIssues((current) => {
      const nextIssue: RouteCleanupIssue = {
        ...issue,
        status,
      };
      const existingIndex = current.findIndex((entry) => entry.id === issue.id);
      if (existingIndex >= 0) {
        const nextIssues = [...current];
        nextIssues[existingIndex] = nextIssue;
        return nextIssues;
      }
      return [...current, nextIssue];
    });
  }, []);

  useEffect(() => {
    if (previewCleanupIssueIds.length === 0) {
      return;
    }

    const availablePreviewIds = new Set(
      (cleanupMetadata?.issues ?? [])
        .filter((issue) => issue.status === 'pending')
        .map((issue) => issue.id)
    );
    setPreviewCleanupIssueIds((current) => {
      const next = current.filter((issueId) => availablePreviewIds.has(issueId));
      return next.length === current.length ? current : next;
    });
  }, [cleanupMetadata, previewCleanupIssueIds.length]);

  const handlePreviewCleanupIssue = useCallback((issue: RouteCleanupIssue): void => {
    setPreviewCleanupIssueIds((current) =>
      current.includes(issue.id) ? current.filter((issueId) => issueId !== issue.id) : [...current, issue.id]
    );
  }, []);

  const removeCleanupIssuePreview = useCallback((issueId: string): void => {
    setPreviewCleanupIssueIds((current) => current.filter((entry) => entry !== issueId));
  }, []);

  const clearCleanupIssuePreviews = useCallback((): void => {
    setPreviewCleanupIssueIds([]);
  }, []);

  const handleApplyCleanupIssue = useCallback(
    (issue: RouteCleanupIssue): void => {
      if (!draftCandidate) {
        return;
      }

      if (!cleanupOriginalGeometry) {
        setCleanupOriginalGeometry(draftCandidate.geometry);
      }
      removeCleanupIssuePreview(issue.id);
      updateCleanupIssueStatus(issue, 'accepted');
      updateDraftGeometry(geometryToPoints(issue.proposedGeometry));
      showSuccess('Applied suggested cleanup to the route geometry.', {
        title: isPublishedMode ? 'Published routes' : 'Route queue',
        dedupeKey: `route-cleanup-apply-${issue.id}`,
      });
    },
    [cleanupOriginalGeometry, draftCandidate, isPublishedMode, removeCleanupIssuePreview, showSuccess, updateCleanupIssueStatus]
  );

  const handleDismissCleanupIssue = useCallback(
    (issue: RouteCleanupIssue): void => {
      removeCleanupIssuePreview(issue.id);
      updateCleanupIssueStatus(issue, 'dismissed');
      showSuccess('Dismissed this cleanup suggestion.', {
        title: isPublishedMode ? 'Published routes' : 'Route queue',
        dedupeKey: `route-cleanup-dismiss-${issue.id}`,
      });
    },
    [isPublishedMode, removeCleanupIssuePreview, showSuccess, updateCleanupIssueStatus]
  );

  const handleApplyAllSafeCleanup = useCallback((): void => {
    if (!draftCandidate || safeCleanupIssues.length === 0) {
      return;
    }

    let nextGeometry = draftCandidate.geometry;
    let nextPoints = geometryToPoints(nextGeometry);
    let nextPersisted = cleanupPersistedIssues;
    const originalGeometry = cleanupOriginalGeometry ?? draftCandidate.geometry;

    for (let iteration = 0; iteration < 6; iteration += 1) {
      const nextMetadata = buildRouteCleanupMetadata(geometryToCleanupPoints(nextGeometry), {
        source: 'editor',
        originalGeometry,
        persistedIssues: nextPersisted,
      });
      const nextIssue = (nextMetadata?.issues ?? []).find(
        (issue) => issue.status === 'pending' && issue.confidence >= 0.82
      );
      if (!nextIssue) {
        break;
      }

      nextPersisted = (() => {
        const existingIndex = nextPersisted.findIndex((entry) => entry.id === nextIssue.id);
        const acceptedIssue: RouteCleanupIssue = { ...nextIssue, status: 'accepted' };
        if (existingIndex >= 0) {
          const updated = [...nextPersisted];
          updated[existingIndex] = acceptedIssue;
          return updated;
        }
        return [...nextPersisted, acceptedIssue];
      })();
      nextGeometry = nextIssue.proposedGeometry;
      nextPoints = geometryToPoints(nextGeometry);
    }

    setCleanupOriginalGeometry(originalGeometry);
    setCleanupPersistedIssues(nextPersisted);
    clearCleanupIssuePreviews();
    updateDraftGeometry(nextPoints);
    showSuccess('Applied the safe cleanup suggestions to this route.', {
      title: isPublishedMode ? 'Published routes' : 'Route queue',
      dedupeKey: `route-cleanup-apply-all-${draftCandidate.id}`,
    });
  }, [
    cleanupOriginalGeometry,
    cleanupPersistedIssues,
    draftCandidate,
    clearCleanupIssuePreviews,
    isPublishedMode,
    safeCleanupIssues.length,
    showSuccess,
  ]);

  const setRouteBoolean = (key: RouteBooleanField, value: boolean): void => {
    setDraftCandidate((current) =>
      current
        ? {
            ...current,
            routeProperties: {
              ...current.routeProperties,
              [key]: value,
            },
          }
        : current
    );
  };

  const handleSaveCandidate = async (): Promise<void> => {
    if (!draftCandidate) {
      showWarning('Select a route candidate before saving changes.', {
        title: panelLabel,
        dedupeKey: `route-candidate-save-missing-${mode}`,
      });
      return;
    }

    setSaving(true);
    try {
      const result = await updateAdminRouteCandidate(draftCandidate.id, {
        title: draftCandidate.title.trim(),
        geometry: draftCandidate.geometry,
        routeProperties: {
          ...draftCandidate.routeProperties,
          name: draftCandidate.routeProperties.name.trim(),
        },
        observedCount: Math.max(0, draftCandidate.observedCount),
        confidence: Math.max(0, Math.min(1, draftCandidate.confidence || 0)),
        averageDistanceM: Math.max(0, draftCandidate.averageDistanceM || selectedDistanceM),
        metadata: {
          ...(isRecord(draftCandidate.metadata) ? draftCandidate.metadata : {}),
          ...(cleanupMetadata ? { geometryCleanup: cleanupMetadata } : {}),
        },
        reviewNotes: reviewNotes.trim(),
      });

      showSuccess(
        isPublishedMode
          ? 'Saved route changes. The live map stays unchanged until you publish again.'
          : 'Saved route changes. The route is not live until you publish it.',
        {
          title: isPublishedMode ? 'Published routes' : 'Route queue',
          dedupeKey: `route-candidate-save-${result.id}`,
        }
      );
      void loadCandidates(result.id);
      onActivityChanged?.();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Unable to save route candidate.', {
        title: isPublishedMode ? 'Published routes' : 'Route queue',
        dedupeKey: `route-candidate-save-${mode}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleApproveCandidate = async (): Promise<void> => {
    if (!draftCandidate) {
      showWarning(
        isPublishedMode ? 'Select a published route before publishing changes.' : 'Select a route candidate before publishing it.',
        {
          title: isPublishedMode ? 'Published routes' : 'Route queue',
          dedupeKey: `route-candidate-approve-missing-${mode}`,
        }
      );
      return;
    }

    setSaving(true);
    try {
      const result = await approveAdminRouteCandidate(draftCandidate.id, {
        title: draftCandidate.title.trim(),
        geometry: draftCandidate.geometry,
        name: draftCandidate.routeProperties.name.trim(),
        accessible: draftCandidate.routeProperties.accessible,
        stairs: draftCandidate.routeProperties.stairs,
        ramp: draftCandidate.routeProperties.ramp,
        elevator: draftCandidate.routeProperties.elevator,
        metadata: {
          ...(isRecord(draftCandidate.metadata) ? draftCandidate.metadata : {}),
          ...(cleanupMetadata ? { geometryCleanup: cleanupMetadata } : {}),
        },
        notes: reviewNotes.trim(),
      });

      await onRoutingPublished(result.datasetMutation, result.overlay);
      showSuccess('Published to live map.', {
        title: 'Route published',
        dedupeKey: `route-candidate-approve-${result.candidate.id}`,
      });
      void loadCandidates(result.candidate.id);
      onActivityChanged?.();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Unable to publish route candidate.', {
        title: isPublishedMode ? 'Published routes' : 'Route queue',
        dedupeKey: `route-candidate-approve-${mode}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRejectCandidate = async (): Promise<void> => {
    if (!draftCandidate) {
      showWarning('Select a route candidate before rejecting it.', {
        title: 'Route queue',
        dedupeKey: 'route-candidate-reject-missing',
      });
      return;
    }

    if (!rejectionReason.trim()) {
      showWarning('Add a rejection reason so the route owner knows what to fix.', {
        title: 'Route queue',
        dedupeKey: 'route-candidate-reject-reason',
      });
      return;
    }

    setSaving(true);
    try {
      const result = await rejectAdminRouteCandidate(draftCandidate.id, {
        notes: reviewNotes.trim(),
        rejectionReason: rejectionReason.trim(),
      });

      showSuccess('Candidate route was rejected and annotated.', {
        title: 'Route queue',
        dedupeKey: `route-candidate-reject-${result.id}`,
      });
      void loadCandidates(result.id);
      onActivityChanged?.();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Unable to reject route candidate.', {
        title: 'Route queue',
        dedupeKey: 'route-candidate-reject',
      });
    } finally {
      setSaving(false);
    }
  };

  const sourceCounts = useMemo(() => {
    return candidates.reduce(
      (accumulator, candidate) => {
        if (candidate.source === 'analytics_discovery') {
          accumulator.analytics += 1;
        } else {
          accumulator.admin += 1;
        }
        return accumulator;
      },
      {
        analytics: 0,
        admin: 0,
      }
    );
  }, [candidates]);

  const panelLabel = isPublishedMode ? 'Published routes' : 'Route queue';
  const panelTitle = isPublishedMode ? 'Live route history' : 'Candidate routes';
  const panelDescription = isPublishedMode
    ? 'Inspect approved routes, review their publish audit trail, and republish edits when the live path needs to change.'
    : 'Review pending routes from admins and analytics, adjust metadata, then publish approved paths into the live routing graph.';
  const emptyStateTitle = isPublishedMode ? 'No published routes match this view' : 'No route candidates match this view';
  const emptyStateMessage = isPublishedMode
    ? 'Try another source filter, or approve a pending route so it moves into the published history.'
    : 'Try another status or source filter, or send a recorded walk into the queue.';

  return (
    <AdminSectionCard
      label={panelLabel}
      title={panelTitle}
      description={panelDescription}
      actions={
        <button
          type="button"
          onClick={() => {
            void loadCandidates(selectedId);
          }}
          disabled={loading}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-4">
          {isPublishedMode ? (
            <>
              <MetricCard label="Published" value={candidateCounts.approved} />
              <MetricCard label="Recorded by admin" value={sourceCounts.admin} />
              <MetricCard label="Analytics worker" value={sourceCounts.analytics} />
              <MetricCard label="Loaded" value={candidates.length} />
            </>
          ) : (
            <>
              <MetricCard label="Pending" value={candidateCounts.pending} />
              <MetricCard label="Rejected" value={candidateCounts.rejected} />
              <MetricCard label="Recorded by admin" value={sourceCounts.admin} />
              <MetricCard label="Analytics worker" value={sourceCounts.analytics} />
            </>
          )}
        </div>

        <div
          className={cx(
            'grid gap-3',
            isPublishedMode ? 'lg:grid-cols-[minmax(0,1fr)_220px]' : 'lg:grid-cols-[minmax(0,1fr)_180px_220px]'
          )}
        >
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Search</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Title, route name, or feature id"
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
            />
          </label>
          {!isPublishedMode ? (
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as QueueStatusFilter)}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
              >
                <option value="all">All queue states</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Source</span>
            <select
              value={sourceFilter}
              onChange={(event) =>
                setSourceFilter(event.target.value as 'all' | RouteCandidateRecord['source'])
              }
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
            >
              <option value="all">All sources</option>
              <option value="analytics_discovery">Discovered by analytics worker</option>
              <option value="admin_recording">Recorded by admin</option>
            </select>
          </label>
        </div>

        <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="space-y-3">
            {loading && candidates.length === 0 ? (
              <div className="rounded-[26px] border border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-600">
                Loading route candidates...
              </div>
            ) : null}
            {!loading && candidates.length === 0 ? (
              <AdminEmptyState
                title={emptyStateTitle}
                message={emptyStateMessage}
              />
            ) : null}
            {candidates.length > 0 ? (
              <div className="max-h-[960px] space-y-3 overflow-y-auto pr-1">
                {candidates.map((candidate) => {
                  const isSelected = candidate.id === selectedId;
                  const isHighlighted = candidate.id === highlightedCandidateId;
                  const distanceM = computePathDistance(geometryToPoints(candidate.geometry));
                  const needsWorkerEdit = candidateNeedsWorkerEdit(candidate);
                  const pendingCleanupCount = readPendingCleanupIssues(candidate).length;

                  return (
                    <button
                      key={candidate.id}
                      ref={(node) => {
                        candidateItemRefs.current[candidate.id] = node;
                      }}
                      type="button"
                      onClick={() => setSelectedId(candidate.id)}
                      className={cx(
                        'w-full rounded-[26px] border px-4 py-4 text-left transition',
                        isSelected
                          ? 'border-sky-300 bg-sky-50 shadow-sm'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
                        isHighlighted ? 'ring-2 ring-sky-300 ring-offset-2' : undefined
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <AdminStatusBadge tone={statusTone(candidate.status)}>{candidate.status}</AdminStatusBadge>
                        <AdminStatusBadge tone={sourceTone(candidate.source)}>
                          {sourceLabel(candidate.source)}
                        </AdminStatusBadge>
                        <AdminStatusBadge>{candidate.campusId}</AdminStatusBadge>
                        <AdminStatusBadge>{formatConfidence(candidate.confidence)}</AdminStatusBadge>
                        {needsWorkerEdit ? <AdminStatusBadge tone="warning">Needs edit</AdminStatusBadge> : null}
                        {pendingCleanupCount > 0 ? <AdminStatusBadge tone="warning">Cleanup suggested</AdminStatusBadge> : null}
                      </div>
                      <h4 className="mt-3 font-['Outfit'] text-lg font-semibold text-slate-950">
                        {candidateDisplayTitle(candidate)}
                      </h4>
                      <p className="mt-2 text-sm text-slate-600">
                        {formatMeters(distanceM)} route, {candidate.observedCount} observations, updated{' '}
                        {formatSharedRelativeTime(candidate.updatedAt)}.
                        {candidate.publish?.publishedAt
                          ? ` Live since ${formatSharedRelativeTime(candidate.publish.publishedAt)}.`
                          : candidate.status === 'pending'
                            ? ' Waiting in the review queue.'
                            : ''}
                        {needsWorkerEdit ? ' Worker flagged this route for manual cleanup.' : ''}
                        {pendingCleanupCount > 0 ? ` ${pendingCleanupCount} cleanup suggestion${pendingCleanupCount === 1 ? '' : 's'} ready.` : ''}
                      </p>
                      {candidate.review?.rejectionReason ? (
                        <p className="mt-2 text-sm text-rose-700">{candidate.review.rejectionReason}</p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="space-y-5">
            {!draftCandidate ? (
              <AdminEmptyState
                title={isPublishedMode ? 'Select a published route' : 'Select a candidate route'}
                message={
                  isPublishedMode
                    ? 'Choose a published route from the list to inspect its live audit trail and republish changes.'
                    : 'Choose a route from the queue to inspect its geometry, routing attributes, and publication status.'
                }
              />
            ) : (
              <>
                <div className="space-y-4 rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                  <RouteLifecycleStrip stage={candidateLifecycleStage(draftCandidate)} />

                  <div className="flex flex-wrap items-center gap-2">
                    <AdminStatusBadge tone={statusTone(draftCandidate.status)}>
                      {draftCandidate.status}
                    </AdminStatusBadge>
                    <AdminStatusBadge tone={sourceTone(draftCandidate.source)}>
                      {sourceLabel(draftCandidate.source)}
                    </AdminStatusBadge>
                    <AdminStatusBadge>{draftCandidate.campusId}</AdminStatusBadge>
                    {geometryDirty ? <AdminStatusBadge tone="warning">Draft geometry</AdminStatusBadge> : null}
                    {needsWorkerEdit ? <AdminStatusBadge tone="warning">Needs edit before approval</AdminStatusBadge> : null}
                  </div>

                  <p className="text-sm leading-6 text-slate-600">
                    {isPublishedMode
                      ? 'This route is already live on the map. Save edits here, then publish again when you want the live routing graph updated.'
                      : 'This route is still in review. Save changes if needed, or publish it to move the path into the live routing map.'}
                  </p>

                  {workerSuggestions.length > 0 ? (
                    <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-800">
                        Worker suggestions
                      </p>
                      <div className="mt-3 space-y-3 text-sm text-amber-950">
                        {workerSuggestions.map((suggestion, index) => (
                          <div key={`${suggestion.type}_${index}`} className="rounded-2xl border border-amber-200/80 bg-white/70 px-3 py-3">
                            <p className="font-semibold">{suggestion.title}</p>
                            {suggestion.message ? <p className="mt-1 text-amber-900/90">{suggestion.message}</p> : null}
                            {suggestion.action ? <p className="mt-2 text-amber-900">{suggestion.action}</p> : null}
                          </div>
                        ))}
                        {buildingCrossingCount > 0 ? (
                          <p>
                            Building intersections detected: {buildingCrossingCount}. Review and reshape this path before approval.
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <RouteCleanupAssistantCard
                    metadata={cleanupMetadata}
                    onApplyIssue={handleApplyCleanupIssue}
                    onDismissIssue={handleDismissCleanupIssue}
                    onPreviewIssue={handlePreviewCleanupIssue}
                    previewIssueIds={previewCleanupIssueIds}
                    onApplyAllSafe={safeCleanupIssues.length > 0 ? handleApplyAllSafeCleanup : undefined}
                  />

                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Candidate title
                      </span>
                      <input
                        type="text"
                        value={draftCandidate.title}
                        onChange={(event) =>
                          setDraftCandidate({
                            ...draftCandidate,
                            title: event.target.value,
                          })
                        }
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Published route name
                      </span>
                      <input
                        type="text"
                        value={draftCandidate.routeProperties.name}
                        onChange={(event) =>
                          setDraftCandidate({
                            ...draftCandidate,
                            routeProperties: {
                              ...draftCandidate.routeProperties,
                              name: event.target.value,
                            },
                          })
                        }
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Observations
                      </span>
                      <input
                        type="number"
                        min={0}
                        value={draftCandidate.observedCount}
                        onChange={(event) =>
                          setDraftCandidate({
                            ...draftCandidate,
                            observedCount: Math.max(0, Number(event.target.value) || 0),
                          })
                        }
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Confidence (%)
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={selectedConfidencePercent}
                        onChange={(event) =>
                          setDraftCandidate({
                            ...draftCandidate,
                            confidence: Math.max(0, Math.min(100, Number(event.target.value) || 0)) / 100,
                          })
                        }
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-4">
                    {ROUTE_BOOLEAN_FIELDS.map((field) => {
                      const active = draftCandidate.routeProperties[field.key];

                      return (
                        <button
                          key={field.key}
                          type="button"
                          onClick={() => setRouteBoolean(field.key, !active)}
                          className={cx(
                            'rounded-2xl border px-4 py-3 text-left transition',
                            active
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                              : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                          )}
                        >
                          <p className="text-xs font-semibold uppercase tracking-[0.14em]">{field.label}</p>
                          <p className="mt-2 text-sm">{active ? 'Enabled' : 'Disabled'}</p>
                        </button>
                      );
                    })}
                  </div>

                  <div className={cx('grid gap-4', isPublishedMode ? undefined : 'lg:grid-cols-2')}>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Review notes
                      </span>
                      <textarea
                        value={reviewNotes}
                        onChange={(event) => setReviewNotes(event.target.value)}
                        rows={4}
                        className="mt-2 w-full rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                    {!isPublishedMode ? (
                      <label className="block">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Rejection reason
                        </span>
                        <textarea
                          value={rejectionReason}
                          onChange={(event) => setRejectionReason(event.target.value)}
                          rows={4}
                          placeholder="What should be corrected before this route can go live?"
                          className="mt-2 w-full rounded-[24px] border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                        />
                      </label>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateDraftGeometry(simplifyPoints(draftPoints))}
                      disabled={saving || draftPoints.length < 3}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Simplify path
                    </button>
                    <button
                      type="button"
                      onClick={() => updateDraftGeometry(snapEndpointsToDataset(draftPoints, routingDataset))}
                      disabled={saving || draftPoints.length < 2}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Snap endpoints
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftCandidate(selectedCandidate ? cloneCandidate(selectedCandidate) : null);
                        const selectedCleanup = readCleanupMetadata(selectedCandidate);
                        setCleanupPersistedIssues(selectedCleanup?.issues ?? []);
                        setCleanupOriginalGeometry(selectedCleanup?.originalGeometry ?? null);
                        clearCleanupIssuePreviews();
                      }}
                      disabled={saving || !selectedCandidate}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Reset draft
                    </button>
                  </div>
                </div>

                <RoutePreviewMap
                  routingDataset={routingDataset}
                  locationsDataset={locationsDataset}
                  candidates={candidates}
                  selectedCandidateId={selectedId}
                  draftGeometry={draftCandidate.geometry}
                  previewGeometries={previewCleanupIssues.map((issue) => issue.proposedGeometry)}
                  autoFrameKey={selectedId}
                />

                <div className="grid gap-3 md:grid-cols-4">
                  <MetricCard label="Route length" value={formatMeters(selectedDistanceM)} />
                  <MetricCard label="Avg. accuracy" value={formatMeters(draftCandidate.averageAccuracyM)} />
                  <MetricCard label="Avg. duration" value={formatDuration(draftCandidate.averageDurationS)} />
                  <MetricCard label="Sessions" value={draftCandidate.distinctSessionCount} />
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                    <h4 className="font-['Outfit'] text-xl font-semibold text-slate-950">Anchors</h4>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Start</p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">
                          {draftCandidate.startAnchor.locationId || draftCandidate.startAnchor.nodeId || 'Unattached'}
                        </p>
                        <p className="mt-2 text-sm text-slate-600">
                          {draftCandidate.startAnchor.snapped
                            ? `Snapped (${draftCandidate.startAnchor.distanceM} m)`
                            : 'Not snapped to routing node'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">End</p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">
                          {draftCandidate.endAnchor.locationId || draftCandidate.endAnchor.nodeId || 'Unattached'}
                        </p>
                        <p className="mt-2 text-sm text-slate-600">
                          {draftCandidate.endAnchor.snapped
                            ? `Snapped (${draftCandidate.endAnchor.distanceM} m)`
                            : 'Not snapped to routing node'}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                    <h4 className="font-['Outfit'] text-xl font-semibold text-slate-950">Audit trail</h4>
                    <div className="mt-4 space-y-3 text-sm text-slate-600">
                      <p>Campus: {draftCandidate.campusId}.</p>
                      <p>Last updated {formatSharedRelativeTime(draftCandidate.updatedAt)} at {formatTimestamp(draftCandidate.updatedAt)}.</p>
                      <p>
                        Reviewed {draftCandidate.review?.reviewedAt ? formatTimestamp(draftCandidate.review.reviewedAt) : '-'} by{' '}
                        {formatActorLabel(draftCandidate.review?.reviewedBy)}.
                      </p>
                      <p>
                        Published {draftCandidate.publish?.publishedAt ? formatTimestamp(draftCandidate.publish.publishedAt) : '-'} by{' '}
                        {formatActorLabel(draftCandidate.publish?.publishedBy)}.
                      </p>
                      <p>Routing revision: {draftCandidate.publish?.routingRevisionId || '-'}</p>
                      <p>Overlay version: {draftCandidate.publish?.overlayVersion || '-'}</p>
                      <p>Improvement estimate: {formatMeters(Math.abs(draftCandidate.improvementDistanceM))}.</p>
                      <p>Telemetry sources attached: {draftCandidate.telemetrySourceIds.length}.</p>
                      <p>Worker edit suggestions: {workerSuggestions.length}.</p>
                      <p>Cleanup suggestions pending: {pendingCleanupIssues.length}.</p>
                      <p>Building intersections flagged: {buildingCrossingCount}.</p>
                      <p>
                        Published feature ids:{' '}
                        {draftCandidate.publish?.featureIds?.length
                          ? draftCandidate.publish.featureIds.join(', ')
                          : 'Not published yet'}.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void handleSaveCandidate();
                    }}
                    disabled={saving}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? 'Working...' : 'Save changes'}
                  </button>
                  {!isPublishedMode ? (
                    <button
                      type="button"
                      onClick={() => {
                        void handleRejectCandidate();
                      }}
                      disabled={saving}
                      className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {saving ? 'Working...' : 'Reject'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      void handleApproveCandidate();
                    }}
                    disabled={saving}
                    className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? 'Publishing...' : isPublishedMode ? 'Publish changes' : 'Publish to live map'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </AdminSectionCard>
  );
};

export const AdminRouteRecordingPanel: React.FC<RouteRecordingPanelProps> = ({
  routingDataset,
  locationsDataset,
  onCandidateChanged,
  onSubmittedToQueue,
  activeView,
  onViewChange,
}) => {
  const { showError, showSuccess, showWarning } = useToast();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [routeName, setRouteName] = useState('');
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [routeProperties, setRouteProperties] = useState<
    Pick<RouteCandidateRecord['routeProperties'], RouteBooleanField>
  >(DEFAULT_RECORDING_ROUTE_PROPERTIES);
  const [saving, setSaving] = useState(false);
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>('draft');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [accuracyTotalM, setAccuracyTotalM] = useState(0);
  const [accuracySampleCount, setAccuracySampleCount] = useState(0);
  const [lastAccuracyM, setLastAccuracyM] = useState<number | null>(null);
  const [lastSampleAtMs, setLastSampleAtMs] = useState<number | null>(null);
  const [livePoint, setLivePoint] = useState<RoutePoint | null>(null);
  const [liveAccuracyM, setLiveAccuracyM] = useState<number | null>(null);
  const [liveHeadingDeg, setLiveHeadingDeg] = useState<number | null>(null);
  const [liveSpeedMps, setLiveSpeedMps] = useState<number | null>(null);
  const [previewPoint, setPreviewPoint] = useState<RoutePoint | null>(null);
  const [previewAccuracyM, setPreviewAccuracyM] = useState<number | null>(null);
  const [previewHeadingDeg, setPreviewHeadingDeg] = useState<number | null>(null);
  const [previewSpeedMps, setPreviewSpeedMps] = useState<number | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle');
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [recentDrafts, setRecentDrafts] = useState<RouteCandidateRecord[]>([]);
  const [loadingRecentDrafts, setLoadingRecentDrafts] = useState(false);
  const [recoveredInterruptedSession, setRecoveredInterruptedSession] = useState(false);
  const [correctionMode, setCorrectionMode] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [mobileCaptureActionsOpen, setMobileCaptureActionsOpen] = useState(false);
  const [mobileReviewDetailsOpen, setMobileReviewDetailsOpen] = useState(false);
  const [mobileImmersiveMode, setMobileImmersiveMode] = useState(true);
  const [cleanupPersistedIssues, setCleanupPersistedIssues] = useState<RouteCleanupIssue[]>([]);
  const [cleanupOriginalGeometry, setCleanupOriginalGeometry] = useState<RouteCandidateRecord['geometry'] | null>(null);
  const [previewCleanupIssueIds, setPreviewCleanupIssueIds] = useState<string[]>([]);

  const pointsRef = useRef<RoutePoint[]>([]);
  const watchIdRef = useRef<number | null>(null);
  const previewWatchIdRef = useRef<number | null>(null);
  const activeSegmentStartedAtRef = useRef<number | null>(null);
  const lastAcceptedTimestampRef = useRef<number | null>(null);
  const hydratedStoredDraftRef = useRef(false);

  const replacePoints = useCallback((nextPoints: RoutePoint[]): void => {
    pointsRef.current = nextPoints;
    setPoints(nextPoints);
  }, []);

  const stopGeolocationWatch = useCallback((): void => {
    if (watchIdRef.current === null || typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return;
    }

    navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
  }, []);

  const stopPreviewLocationWatch = useCallback((): void => {
    if (previewWatchIdRef.current === null || typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return;
    }

    navigator.geolocation.clearWatch(previewWatchIdRef.current);
    previewWatchIdRef.current = null;
  }, []);

  const commitActiveSegment = useCallback((): void => {
    if (!activeSegmentStartedAtRef.current) {
      return;
    }

    const additionalMs = Math.max(0, Date.now() - activeSegmentStartedAtRef.current);
    activeSegmentStartedAtRef.current = null;

    if (additionalMs > 0) {
      setElapsedMs((current) => current + additionalMs);
    }
  }, []);

  const transitionOutOfRecording = useCallback(
    (nextPhase: RecordingPhase): void => {
      stopGeolocationWatch();
      commitActiveSegment();
      setRecordingPhase(nextPhase);
      setGpsStatus('idle');
    },
    [commitActiveSegment, stopGeolocationWatch]
  );

  const loadRecentDrafts = useCallback(
    async ({ notifyOnError = false }: RecentDraftLoadOptions = {}): Promise<void> => {
      setLoadingRecentDrafts(true);
      try {
        const result = await fetchAdminRouteCandidates({
          source: 'admin_recording',
          status: 'draft',
          pageSize: 6,
        });
        setRecentDrafts(result.items);
      } catch (error) {
        if (notifyOnError) {
          showError(error instanceof Error ? error.message : 'Unable to load saved walk drafts.', {
            title: 'Route recording',
            dedupeKey: 'route-recording-drafts-load',
          });
        }
      } finally {
        setLoadingRecentDrafts(false);
      }
    },
    [showError]
  );

  useEffect(() => {
    if (hydratedStoredDraftRef.current) {
      return;
    }

    hydratedStoredDraftRef.current = true;
    const storedDraft = readStoredRecordingDraft();
    if (!storedDraft) {
      return;
    }

    setDraftId(storedDraft.draftId);
    setTitle(storedDraft.title);
    setRouteName(storedDraft.routeName);
    replacePoints(storedDraft.points);
    setRouteProperties(storedDraft.routeProperties);
    setRecordingPhase(storedDraft.recordingPhase);
    setElapsedMs(storedDraft.elapsedMs);
    setAccuracyTotalM(storedDraft.accuracyTotalM);
    setAccuracySampleCount(storedDraft.accuracySampleCount);
    setLastAccuracyM(storedDraft.lastAccuracyM);
    setLastSampleAtMs(storedDraft.lastSampleAtMs);
    setLivePoint(storedDraft.points[storedDraft.points.length - 1] ?? null);
    setLiveAccuracyM(storedDraft.lastAccuracyM);
    setLiveHeadingDeg(null);
    setLiveSpeedMps(null);
    setCleanupPersistedIssues(storedDraft.cleanupMetadata?.issues ?? []);
    setCleanupOriginalGeometry(storedDraft.cleanupMetadata?.originalGeometry ?? null);
    lastAcceptedTimestampRef.current = storedDraft.lastSampleAtMs;
    setRecoveredInterruptedSession(storedDraft.recordingPhase === 'paused');
    if (storedDraft.points.length > 0) {
      onViewChange(storedDraft.recordingPhase === 'paused' ? 'capture' : 'review');
    }
  }, [onViewChange, replacePoints]);

  useEffect(() => {
    void loadRecentDrafts();
  }, [loadRecentDrafts]);

  useEffect(() => {
    if (recordingPhase !== 'recording' || typeof window === 'undefined') {
      return;
    }

    setClockMs(Date.now());
    const timerId = window.setInterval(() => {
      setClockMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [recordingPhase]);

  useEffect(() => {
    return () => {
      stopGeolocationWatch();
      stopPreviewLocationWatch();
    };
  }, [stopGeolocationWatch, stopPreviewLocationWatch]);

  useEffect(() => {
    if (activeView !== 'review') {
      setCorrectionMode(false);
    }
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'capture' || recordingPhase === 'recording') {
      setMobileCaptureActionsOpen(false);
    }
  }, [activeView, recordingPhase]);

  useEffect(() => {
    if (activeView !== 'review') {
      setMobileReviewDetailsOpen(false);
    }
  }, [activeView]);

  useEffect(() => {
    if (
      recordingPhase === 'recording' ||
      (activeView !== 'capture' && activeView !== 'review') ||
      typeof navigator === 'undefined' ||
      !('geolocation' in navigator)
    ) {
      stopPreviewLocationWatch();
      return;
    }

    if (previewWatchIdRef.current !== null) {
      return;
    }

    try {
      previewWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          setPreviewPoint([position.coords.longitude, position.coords.latitude]);
          setPreviewAccuracyM(
            typeof position.coords.accuracy === 'number' && Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null
          );
          setPreviewHeadingDeg(
            typeof position.coords.heading === 'number' && Number.isFinite(position.coords.heading) && position.coords.heading >= 0
              ? position.coords.heading
              : null
          );
          setPreviewSpeedMps(
            typeof position.coords.speed === 'number' && Number.isFinite(position.coords.speed)
              ? position.coords.speed
              : null
          );
        },
        () => {
          setPreviewHeadingDeg(null);
          setPreviewAccuracyM(null);
          setPreviewSpeedMps(null);
          setPreviewPoint(null);
          stopPreviewLocationWatch();
        },
        PREVIEW_LOCATION_WATCH_OPTIONS
      );
    } catch {
      setPreviewHeadingDeg(null);
      setPreviewAccuracyM(null);
      setPreviewSpeedMps(null);
      setPreviewPoint(null);
      stopPreviewLocationWatch();
    }

    return () => {
      stopPreviewLocationWatch();
    };
  }, [activeView, recordingPhase, stopPreviewLocationWatch]);

  const effectiveElapsedMs = useMemo(() => {
    if (recordingPhase !== 'recording' || !activeSegmentStartedAtRef.current) {
      return elapsedMs;
    }

    return elapsedMs + Math.max(0, clockMs - activeSegmentStartedAtRef.current);
  }, [clockMs, elapsedMs, recordingPhase]);

  const averageAccuracyM = useMemo(() => {
    if (accuracySampleCount <= 0) {
      return 0;
    }

    return accuracyTotalM / accuracySampleCount;
  }, [accuracySampleCount, accuracyTotalM]);

  const draftGeometry = useMemo(() => {
    return points.length >= 2 ? pointsToGeometry(points) : null;
  }, [points]);

  const routeDistanceM = useMemo(() => computePathDistance(points), [points]);
  const preparedPoints = useMemo(() => {
    const simplified = simplifyPoints(points);
    return snapEndpointsToDataset(simplified, routingDataset);
  }, [points, routingDataset]);
  const preparedRouteDistanceM = useMemo(() => computePathDistance(preparedPoints), [preparedPoints]);
  const cleanupMetadata = useMemo(() => {
    return buildRouteCleanupMetadata(geometryToCleanupPoints(pointsToGeometry(preparedPoints)), {
      source: 'editor',
      originalGeometry: cleanupOriginalGeometry,
      persistedIssues: cleanupPersistedIssues,
    });
  }, [cleanupOriginalGeometry, cleanupPersistedIssues, preparedPoints]);
  const pendingCleanupIssues = useMemo(() => {
    return (cleanupMetadata?.issues ?? []).filter((issue) => issue.status === 'pending');
  }, [cleanupMetadata]);
  const safeCleanupIssues = useMemo(() => {
    return pendingCleanupIssues.filter((issue) => issue.confidence >= 0.82);
  }, [pendingCleanupIssues]);
  const previewCleanupIssues = useMemo(() => {
    if (previewCleanupIssueIds.length === 0) {
      return [];
    }

    const selectedPreviewIds = new Set(previewCleanupIssueIds);
    return (cleanupMetadata?.issues ?? []).filter(
      (issue) => issue.status === 'pending' && selectedPreviewIds.has(issue.id)
    );
  }, [cleanupMetadata, previewCleanupIssueIds]);
  const lastFixAgeS = useMemo(() => {
    if (!lastSampleAtMs) {
      return null;
    }

    return Math.max(0, Math.round((clockMs - lastSampleAtMs) / 1000));
  }, [clockMs, lastSampleAtMs]);
  const canManuallyEdit = activeView === 'review' && correctionMode && recordingPhase !== 'recording' && points.length > 0;
  const canPersist = recordingPhase !== 'recording' && preparedPoints.length >= 2;
  const recordingActionLabel =
    recordingPhase === 'paused'
      ? 'Resume recording'
      : recordingPhase === 'stopped' || points.length > 0
        ? 'Continue recording'
        : 'Start recording';
  const draftStatusLabel =
    recordingPhase === 'recording'
      ? 'Live'
      : draftId
        ? 'Saved'
        : recordingPhase === 'stopped'
          ? 'Review'
          : 'Local';
  const hasAnyPath = points.length > 0;
  const hasRouteMetadataChanges =
    title.trim().length > 0 ||
    routeName.trim().length > 0 ||
    ROUTE_BOOLEAN_FIELDS.some((field) => routeProperties[field.key] !== DEFAULT_RECORDING_ROUTE_PROPERTIES[field.key]);
  const hasDiscardableLocalSession = hasAnyPath || Boolean(draftId) || hasRouteMetadataChanges || effectiveElapsedMs > 0;
  const canPauseCapture = recordingPhase === 'recording';
  const canStopCapture = recordingPhase === 'recording' || recordingPhase === 'paused';
  const canResumeStoppedCapture = recordingPhase === 'stopped' && hasAnyPath;
  const canOpenReview = recordingPhase !== 'recording' && hasAnyPath;
  const canOpenSavedDrafts = recordingPhase !== 'recording';
  const hasMobileSecondaryCaptureActions = canResumeStoppedCapture || canOpenSavedDrafts || hasDiscardableLocalSession;
  const canToggleCorrectionMode = recordingPhase !== 'recording' && points.length > 0;
  const canUndoDraftPoint = recordingPhase !== 'recording' && points.length > 0;
  const canTrimDraftPath = recordingPhase !== 'recording' && points.length >= 3;
  const canSnapDraftPath = recordingPhase !== 'recording' && points.length >= 2;
  const hasVisibleCleanupActions = canToggleCorrectionMode || canUndoDraftPoint || canTrimDraftPath || canSnapDraftPath;
  const isMobileFocusedView = activeView === 'capture' || activeView === 'review';
  const isMobileImmersiveView = isMobileFocusedView && mobileImmersiveMode;
  const recordingLifecycleStage: RouteLifecycleStage = recordingPhase === 'recording' ? 'capture' : 'draft';
  const recordingAutoFrameKey = draftId ? `draft:${draftId}` : null;
  const currentMapPoint = recordingPhase === 'recording' ? livePoint : previewPoint;
  const currentMapAccuracyM = recordingPhase === 'recording' ? liveAccuracyM : previewAccuracyM;
  const currentMapHeadingDeg = recordingPhase === 'recording' ? liveHeadingDeg : previewHeadingDeg;
  const currentMapSpeedMps = recordingPhase === 'recording' ? liveSpeedMps : previewSpeedMps;

  useEffect(() => {
    if (activeView !== 'review') {
      setPreviewCleanupIssueIds([]);
    }
  }, [activeView]);

  useEffect(() => {
    if (previewCleanupIssueIds.length === 0) {
      return;
    }

    const availablePreviewIds = new Set(
      (cleanupMetadata?.issues ?? [])
        .filter((issue) => issue.status === 'pending')
        .map((issue) => issue.id)
    );
    setPreviewCleanupIssueIds((current) => {
      const next = current.filter((issueId) => availablePreviewIds.has(issueId));
      return next.length === current.length ? current : next;
    });
  }, [cleanupMetadata, previewCleanupIssueIds.length]);

  useEffect(() => {
    writeStoredRecordingDraft({
      draftId,
      title,
      routeName,
      points,
      routeProperties,
      recordingPhase,
      elapsedMs: effectiveElapsedMs,
      accuracyTotalM,
      accuracySampleCount,
      lastAccuracyM,
      lastSampleAtMs,
      cleanupMetadata,
    });
  }, [
    accuracySampleCount,
    accuracyTotalM,
    cleanupMetadata,
    draftId,
    effectiveElapsedMs,
    lastAccuracyM,
    lastSampleAtMs,
    points,
    recordingPhase,
    routeName,
    routeProperties,
    title,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const mobileQuery = window.matchMedia('(max-width: 639px)');
    if (!isMobileImmersiveView || !mobileQuery.matches) {
      return;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [isMobileImmersiveView]);

  const appendPoint = useCallback(
    (point: RoutePoint): void => {
      if (recordingPhase === 'recording') {
        return;
      }

      const nextPoints = [...pointsRef.current, point];
      replacePoints(nextPoints);
      setLivePoint(point);
      setLiveHeadingDeg(null);
      setLiveSpeedMps(null);
    },
    [recordingPhase, replacePoints]
  );

  const applyDraftPoints = useCallback(
    (nextPoints: RoutePoint[]): void => {
      replacePoints(nextPoints);
      setLivePoint(nextPoints[nextPoints.length - 1] ?? null);
      setLiveHeadingDeg(null);
      setLiveSpeedMps(null);
    },
    [replacePoints]
  );

  const updateCleanupIssueStatus = useCallback((issue: RouteCleanupIssue, status: RouteCleanupIssue['status']): void => {
    setCleanupPersistedIssues((current) => {
      const nextIssue: RouteCleanupIssue = {
        ...issue,
        status,
      };
      const existingIndex = current.findIndex((entry) => entry.id === issue.id);
      if (existingIndex >= 0) {
        const nextIssues = [...current];
        nextIssues[existingIndex] = nextIssue;
        return nextIssues;
      }
      return [...current, nextIssue];
    });
  }, []);

  const handleApplyCleanupIssue = useCallback(
    (issue: RouteCleanupIssue): void => {
      if (!cleanupOriginalGeometry) {
        setCleanupOriginalGeometry(pointsToGeometry(preparedPoints));
      }
      setPreviewCleanupIssueIds((current) => current.filter((entry) => entry !== issue.id));
      updateCleanupIssueStatus(issue, 'accepted');
      applyDraftPoints(geometryToPoints(issue.proposedGeometry));
      showSuccess('Applied suggested cleanup to the walk path.', {
        title: 'Route recording',
        dedupeKey: `route-recording-cleanup-apply-${issue.id}`,
      });
    },
    [applyDraftPoints, cleanupOriginalGeometry, preparedPoints, showSuccess, updateCleanupIssueStatus]
  );

  const handleDismissCleanupIssue = useCallback(
    (issue: RouteCleanupIssue): void => {
      setPreviewCleanupIssueIds((current) => current.filter((entry) => entry !== issue.id));
      updateCleanupIssueStatus(issue, 'dismissed');
      showSuccess('Dismissed this cleanup suggestion.', {
        title: 'Route recording',
        dedupeKey: `route-recording-cleanup-dismiss-${issue.id}`,
      });
    },
    [showSuccess, updateCleanupIssueStatus]
  );

  const handlePreviewCleanupIssue = useCallback((issue: RouteCleanupIssue): void => {
    setPreviewCleanupIssueIds((current) =>
      current.includes(issue.id) ? current.filter((issueId) => issueId !== issue.id) : [...current, issue.id]
    );
  }, []);

  const handleApplyAllSafeCleanup = useCallback((): void => {
    if (safeCleanupIssues.length === 0) {
      return;
    }

    let nextGeometry = pointsToGeometry(preparedPoints);
    let nextPoints = geometryToPoints(nextGeometry);
    let nextPersisted = cleanupPersistedIssues;
    const originalGeometry = cleanupOriginalGeometry ?? nextGeometry;

    for (let iteration = 0; iteration < 6; iteration += 1) {
      const nextMetadata = buildRouteCleanupMetadata(geometryToCleanupPoints(nextGeometry), {
        source: 'editor',
        originalGeometry,
        persistedIssues: nextPersisted,
      });
      const nextIssue = (nextMetadata?.issues ?? []).find(
        (issue) => issue.status === 'pending' && issue.confidence >= 0.82
      );
      if (!nextIssue) {
        break;
      }

      const acceptedIssue: RouteCleanupIssue = { ...nextIssue, status: 'accepted' };
      const existingIndex = nextPersisted.findIndex((entry) => entry.id === nextIssue.id);
      nextPersisted =
        existingIndex >= 0
          ? nextPersisted.map((entry, index) => (index === existingIndex ? acceptedIssue : entry))
          : [...nextPersisted, acceptedIssue];
      nextGeometry = nextIssue.proposedGeometry;
      nextPoints = geometryToPoints(nextGeometry);
    }

    setCleanupOriginalGeometry(originalGeometry);
    setCleanupPersistedIssues(nextPersisted);
    setPreviewCleanupIssueIds([]);
    applyDraftPoints(nextPoints);
    showSuccess('Applied the safe cleanup suggestions to this walk.', {
      title: 'Route recording',
      dedupeKey: 'route-recording-cleanup-apply-all',
    });
  }, [
    applyDraftPoints,
    cleanupOriginalGeometry,
    cleanupPersistedIssues,
    preparedPoints,
    safeCleanupIssues.length,
    showSuccess,
  ]);

  const loadDraftIntoRecorder = useCallback(
    (candidate: RouteCandidateRecord, targetView: RouteRecordingView = 'review'): void => {
      const nextPoints = geometryToPoints(candidate.geometry);
      const restoredPointCount = nextPoints.length;
      const restoredAccuracyM = Math.max(0, Number(candidate.averageAccuracyM) || 0);
      const restoredDurationMs = Math.max(0, Math.round((candidate.averageDurationS || 0) * 1000));
      const updatedAtMs = new Date(candidate.updatedAt).getTime();

      transitionOutOfRecording('stopped');
      setDraftId(candidate.id);
      setTitle(candidate.title);
      setRouteName(candidate.routeProperties.name);
      replacePoints(nextPoints);
      setRouteProperties({
        accessible: candidate.routeProperties.accessible,
        stairs: candidate.routeProperties.stairs,
        ramp: candidate.routeProperties.ramp,
        elevator: candidate.routeProperties.elevator,
      });
      setRecordingPhase('stopped');
      setElapsedMs(restoredDurationMs);
      setAccuracySampleCount(restoredPointCount);
      setAccuracyTotalM(restoredAccuracyM * restoredPointCount);
      setLastAccuracyM(restoredAccuracyM > 0 ? restoredAccuracyM : null);
      setLastSampleAtMs(Number.isFinite(updatedAtMs) ? updatedAtMs : null);
      setLivePoint(nextPoints[nextPoints.length - 1] ?? null);
      setLiveAccuracyM(restoredAccuracyM > 0 ? restoredAccuracyM : null);
      setLiveHeadingDeg(null);
      setLiveSpeedMps(null);
      setGpsStatus('idle');
      setGpsError(null);
      lastAcceptedTimestampRef.current = Number.isFinite(updatedAtMs) ? updatedAtMs : null;
      setRecoveredInterruptedSession(false);
      setCorrectionMode(false);
      const cleanupMetadata = readCleanupMetadata(candidate);
      setCleanupPersistedIssues(cleanupMetadata?.issues ?? []);
      setCleanupOriginalGeometry(cleanupMetadata?.originalGeometry ?? null);
      onViewChange(targetView);

      showSuccess('Saved walk draft loaded into the recorder.', {
        title: 'Route recording',
        dedupeKey: `route-recording-load-${candidate.id}`,
      });
    },
    [onViewChange, replacePoints, showSuccess, transitionOutOfRecording]
  );

  const startRecording = useCallback((): void => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGpsStatus('unsupported');
      setGpsError('Geolocation is not supported by this browser.');
      showError('Geolocation is not supported by this browser.', {
        title: 'Route recording',
        dedupeKey: 'route-recording-geolocation-unsupported',
      });
      return;
    }

    if (watchIdRef.current !== null) {
      return;
    }

    stopPreviewLocationWatch();
    setRecoveredInterruptedSession(false);
    setGpsStatus('requesting');
    setGpsError(null);
    setClockMs(Date.now());
    activeSegmentStartedAtRef.current = Date.now();
    setRecordingPhase('recording');

    try {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const nextPoint: RoutePoint = [position.coords.longitude, position.coords.latitude];
          const accuracyM =
            typeof position.coords.accuracy === 'number' && Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null;
          const timestampMs = Number.isFinite(position.timestamp) ? position.timestamp : Date.now();
          const previousPoint = pointsRef.current[pointsRef.current.length - 1] ?? null;
          const previousTimestampMs = lastAcceptedTimestampRef.current;
          const distanceM = previousPoint ? haversineMeters(previousPoint, nextPoint) : Number.POSITIVE_INFINITY;
          const idleMs = previousTimestampMs
            ? Math.max(0, timestampMs - previousTimestampMs)
            : Number.POSITIVE_INFINITY;

          setGpsStatus('ready');
          setGpsError(null);
          setLivePoint(nextPoint);
          setLiveAccuracyM(accuracyM);
          setLiveHeadingDeg(
            typeof position.coords.heading === 'number' && Number.isFinite(position.coords.heading) && position.coords.heading >= 0
              ? position.coords.heading
              : null
          );
          setLiveSpeedMps(
            typeof position.coords.speed === 'number' && Number.isFinite(position.coords.speed)
              ? position.coords.speed
              : null
          );
          setLastSampleAtMs(timestampMs);

          if (
            !previousPoint ||
            distanceM >= LIVE_RECORDING_MIN_POINT_DISTANCE_M ||
            idleMs >= LIVE_RECORDING_MAX_IDLE_INTERVAL_MS
          ) {
            const nextPoints = [...pointsRef.current, nextPoint];
            replacePoints(nextPoints);
            lastAcceptedTimestampRef.current = timestampMs;
          }

          if (typeof accuracyM === 'number') {
            setAccuracyTotalM((current) => current + accuracyM);
            setAccuracySampleCount((current) => current + 1);
            setLastAccuracyM(accuracyM);
          } else {
            setLastAccuracyM(null);
          }
        },
        (error) => {
          const message = toGeolocationErrorMessage(error);
          stopGeolocationWatch();
          commitActiveSegment();
          setRecordingPhase(pointsRef.current.length > 0 ? 'paused' : 'draft');
          setGpsStatus(error.code === error.PERMISSION_DENIED ? 'denied' : 'error');
          setGpsError(message);
          showError(message, {
            title: 'Route recording',
            dedupeKey: `route-recording-watch-${error.code}`,
          });
        },
        LIVE_RECORDING_WATCH_OPTIONS
      );
    } catch (error) {
      stopGeolocationWatch();
      commitActiveSegment();
      setRecordingPhase(pointsRef.current.length > 0 ? 'paused' : 'draft');
      setGpsStatus('error');
      setGpsError(error instanceof Error ? error.message : 'Unable to start live recording.');
      showError(error instanceof Error ? error.message : 'Unable to start live recording.', {
        title: 'Route recording',
        dedupeKey: 'route-recording-start',
      });
    }
  }, [commitActiveSegment, replacePoints, showError, stopGeolocationWatch, stopPreviewLocationWatch]);

  const resetRecordingDraft = (): void => {
    stopGeolocationWatch();
    activeSegmentStartedAtRef.current = null;
    lastAcceptedTimestampRef.current = null;
    setDraftId(null);
    setTitle('');
    setRouteName('');
    replacePoints([]);
    setRouteProperties(DEFAULT_RECORDING_ROUTE_PROPERTIES);
    setRecordingPhase('draft');
    setElapsedMs(0);
    setAccuracyTotalM(0);
    setAccuracySampleCount(0);
    setLastAccuracyM(null);
    setLastSampleAtMs(null);
    setLivePoint(null);
    setLiveAccuracyM(null);
    setLiveHeadingDeg(null);
    setLiveSpeedMps(null);
    setGpsStatus('idle');
    setGpsError(null);
    setRecoveredInterruptedSession(false);
    setCorrectionMode(false);
    setCleanupPersistedIssues([]);
    setCleanupOriginalGeometry(null);
    setPreviewCleanupIssueIds([]);
    setMobileCaptureActionsOpen(false);
    setMobileReviewDetailsOpen(false);
    writeStoredRecordingDraft(null);
    onViewChange('capture');
  };

  const handleDeleteServerDraft = useCallback(
    async (candidate: RouteCandidateRecord): Promise<void> => {
      if (!candidate?.id) {
        return;
      }

      if (
        typeof window !== 'undefined' &&
        !window.confirm(
          `Delete the saved draft "${candidateDisplayTitle(candidate)}" from the server? If it is currently loaded, the recorder will keep a local unsaved copy.`
        )
      ) {
        return;
      }

      setSaving(true);
      try {
        await deleteAdminRouteRecordingDraft(candidate.id);
        setRecentDrafts((current) => current.filter((entry) => entry.id !== candidate.id));

        if (draftId === candidate.id) {
          setDraftId(null);
        }

        showSuccess(
          draftId === candidate.id
            ? 'Server draft deleted. The current recorder copy is now local only.'
            : 'Server draft deleted.',
          {
            title: 'Route recording',
            dedupeKey: `route-recording-delete-draft-${candidate.id}`,
          }
        );
        onCandidateChanged?.();
        void loadRecentDrafts();
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Unable to delete saved route draft.', {
          title: 'Route recording',
          dedupeKey: `route-recording-delete-draft-${candidate.id}`,
        });
      } finally {
        setSaving(false);
      }
    },
    [draftId, loadRecentDrafts, onCandidateChanged, showError, showSuccess]
  );

  const persistRecording = async (submit: boolean): Promise<void> => {
    if (recordingPhase === 'recording') {
      showWarning('Pause or stop the live walk before saving it or sending it to the queue.', {
        title: 'Route recording',
        dedupeKey: 'route-recording-active-save',
      });
      return;
    }

    if (preparedPoints.length < 2) {
      showWarning('Record at least two fixes before saving this walk.', {
        title: 'Route recording',
        dedupeKey: 'route-recording-too-short',
      });
      return;
    }

    const fallbackTitle = `Walk ${formatCompactDateTime(Date.now())}`;
    const resolvedTitle = title.trim() || routeName.trim() || fallbackTitle;
    const resolvedRouteName = routeName.trim() || resolvedTitle;
    const resolvedDurationS = Math.max(0, Math.round(effectiveElapsedMs / 1000));
    const resolvedAccuracyM = accuracySampleCount > 0 ? Number(averageAccuracyM.toFixed(1)) : 0;

    setSaving(true);
    try {
      const payload = {
        draftId: draftId ?? undefined,
        campusId: clientConfig.campus_id,
        title: resolvedTitle,
        geometry: pointsToGeometry(preparedPoints),
        routeProperties: {
          ...routeProperties,
          name: resolvedRouteName,
        },
        observedCount: 1,
        distinctSessionCount: 1,
        confidence: submit ? 0.9 : 0.75,
        averageDistanceM: Math.max(routeDistanceM, preparedRouteDistanceM),
        averageDurationS: resolvedDurationS,
        averageAccuracyM: resolvedAccuracyM,
        metadata: {
          captureMode: 'live_walk_recording',
          localPointCount: points.length,
          preparedPointCount: preparedPoints.length,
          lastAccuracyM,
          lastSampleAt: lastSampleAtMs ? new Date(lastSampleAtMs).toISOString() : null,
          ...(cleanupMetadata ? { geometryCleanup: cleanupMetadata } : {}),
        },
      };

      const result = submit
        ? await submitAdminRouteRecording(payload)
        : await saveAdminRouteRecordingDraft(payload);

      const normalizedPoints = geometryToPoints(result.geometry);
      const normalizedPropertyFlags = {
        accessible: result.routeProperties.accessible,
        stairs: result.routeProperties.stairs,
        ramp: result.routeProperties.ramp,
        elevator: result.routeProperties.elevator,
      };
      const restoredPointCount = submit ? 0 : normalizedPoints.length;
      const persistedAccuracyM = Math.max(0, Number(result.averageAccuracyM) || resolvedAccuracyM);
      const persistedDurationS = Math.max(0, Number(result.averageDurationS) || resolvedDurationS);
      const persistedCleanupMetadata = readCleanupMetadata(result);

      setDraftId(submit ? null : result.id);
      setTitle(submit ? '' : result.title);
      setRouteName(submit ? '' : result.routeProperties.name);
      replacePoints(submit ? [] : normalizedPoints);
      setRouteProperties(submit ? DEFAULT_RECORDING_ROUTE_PROPERTIES : normalizedPropertyFlags);
      setRecordingPhase(submit ? 'draft' : 'stopped');
      setElapsedMs(submit ? 0 : Math.round(persistedDurationS * 1000));
      setAccuracySampleCount(restoredPointCount);
      setAccuracyTotalM(submit ? 0 : persistedAccuracyM * restoredPointCount);
      setLastAccuracyM(submit ? null : persistedAccuracyM > 0 ? persistedAccuracyM : null);
      setLastSampleAtMs(submit ? null : lastSampleAtMs);
      setLivePoint(submit ? null : normalizedPoints[normalizedPoints.length - 1] ?? null);
      setLiveAccuracyM(submit ? null : persistedAccuracyM > 0 ? persistedAccuracyM : null);
      setLiveHeadingDeg(null);
      setLiveSpeedMps(null);
      setGpsStatus('idle');
      setGpsError(null);
      setRecoveredInterruptedSession(false);
      setCorrectionMode(false);
      setCleanupPersistedIssues(submit ? [] : persistedCleanupMetadata?.issues ?? cleanupMetadata?.issues ?? []);
      setCleanupOriginalGeometry(submit ? null : persistedCleanupMetadata?.originalGeometry ?? cleanupMetadata?.originalGeometry ?? null);
      lastAcceptedTimestampRef.current = submit ? null : lastSampleAtMs;

      if (submit) {
        writeStoredRecordingDraft(null);
        onSubmittedToQueue?.(result.id);
        if (!onSubmittedToQueue) {
          onViewChange('capture');
        }
        showSuccess('Sent to queue. Not live until approved.', {
          title: 'Route recording',
          dedupeKey: `route-recording-submit-${result.id}`,
        });
      } else {
        showSuccess('Saved to drafts. Not live on map yet.', {
          title: 'Route recording',
          dedupeKey: `route-recording-save-${result.id}`,
        });
      }

      onCandidateChanged?.();
      void loadRecentDrafts();
    } catch (error) {
        showError(
        error instanceof Error
          ? error.message
          : submit
            ? 'Unable to send route recording to the queue.'
            : 'Unable to save route recording draft.',
        {
          title: 'Route recording',
          dedupeKey: submit ? 'route-recording-submit' : 'route-recording-save',
        }
      );
    } finally {
      setSaving(false);
    }
  };

  const handleContinueRecording = (): void => {
    setCorrectionMode(false);
    setMobileCaptureActionsOpen(false);
    setMobileReviewDetailsOpen(false);
    onViewChange('capture');
  };

  const handleOpenReview = (): void => {
    if (!hasAnyPath) {
      return;
    }

    setCorrectionMode(false);
    setMobileCaptureActionsOpen(false);
    onViewChange('review');
  };

  const trimStartPoint = (): void => {
    if (pointsRef.current.length < 3) {
      return;
    }

    applyDraftPoints(pointsRef.current.slice(1));
  };

  const trimEndPoint = (): void => {
    if (pointsRef.current.length < 3) {
      return;
    }

    applyDraftPoints(pointsRef.current.slice(0, -1));
  };

  const handleStopRecording = (): void => {
    const shouldReview = pointsRef.current.length > 0;
    transitionOutOfRecording(shouldReview ? 'stopped' : 'draft');
    if (shouldReview) {
      setCorrectionMode(false);
      onViewChange('review');
    }
  };

  const undoLastPoint = (): void => {
    const nextPoints = pointsRef.current.slice(0, -1);
    applyDraftPoints(nextPoints);
  };

  const simplifyDraftPath = (): void => {
    applyDraftPoints(simplifyPoints(pointsRef.current));
  };

  const snapDraftEndpoints = (): void => {
    applyDraftPoints(snapEndpointsToDataset(pointsRef.current, routingDataset));
  };

  const sectionTitle =
    activeView === 'capture'
      ? 'Capture a live walk'
      : activeView === 'review'
        ? 'Review recorded walk'
        : 'Saved walk drafts';
  const sectionDescription =
    activeView === 'capture'
      ? 'Start a live walk recording, watch the path update in real time, then pause or stop when you are ready to review it.'
      : activeView === 'review'
        ? 'Clean up the recorded path, add route metadata, then save the draft or send it to the queue when the walk looks right.'
        : 'Reopen saved walk drafts, send one back into capture, or continue editing it in review.';
  const updatedAtLabel = lastSampleAtMs ? formatCompactDateTime(lastSampleAtMs) : 'No GPS fix captured yet';
  const lastFixLabel =
    lastFixAgeS !== null
      ? `Last GPS fix ${formatDuration(lastFixAgeS)} ago.`
      : 'Start recording and walk with this page open to capture the route live.';
  const mobileCaptureStatusText = gpsError
    ? 'Location needs attention. Fix GPS or stop to review the points already captured.'
    : recordingPhase === 'recording'
      ? lastFixLabel
      : recordingPhase === 'paused'
        ? 'Recording paused. Resume to keep walking, or stop to move into review.'
        : recordingPhase === 'stopped'
          ? 'Recording stopped. Review the walk now, or open more actions for secondary options.'
          : 'Start recording when you are ready to capture a live walking path.';
  const mobileReviewStatusText = correctionMode
    ? 'Tap directly on the map to append correction points before saving this draft.'
    : 'Clean up the path, then save the draft. Sending it to the queue stays in the desktop workflow.';

  return (
    <AdminSectionCard
      label="Route recording"
      title={sectionTitle}
      description={sectionDescription}
      className={cx(
        isMobileImmersiveView
          ? '-mx-5 overflow-hidden rounded-none border-0 bg-transparent shadow-none sm:mx-0 sm:rounded-3xl sm:border sm:border-slate-200 sm:bg-white sm:shadow-sm'
          : undefined
      )}
      headerClassName={cx(isMobileImmersiveView ? 'hidden sm:flex' : undefined)}
      bodyClassName={cx(isMobileImmersiveView ? 'p-0 sm:px-6 sm:py-5' : undefined)}
    >
      <div className="space-y-5">
        {activeView !== 'capture' && recordingPhase === 'recording' ? (
          <div className="rounded-[28px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
            Live recording is still running in the background. Return to Capture to pause or stop the walk safely.
          </div>
        ) : null}

        {activeView === 'capture' ? (
          <>
            <div className={cx('sm:hidden', mobileImmersiveMode ? 'fixed inset-0 z-[45]' : 'relative')}>
              <RoutePreviewMap
                routingDataset={routingDataset}
                locationsDataset={locationsDataset}
                candidates={[]}
                draftGeometry={draftGeometry}
                draftPoints={points}
                livePoint={currentMapPoint}
                liveAccuracyM={currentMapAccuracyM}
                liveHeadingDeg={currentMapHeadingDeg}
                liveSpeedMps={currentMapSpeedMps}
                autoFrameKey={recordingAutoFrameKey}
                className="rounded-none border-0 bg-slate-950 p-0"
                mapClassName={mobileImmersiveMode ? 'h-[100dvh] min-h-[100dvh] rounded-none border-0' : 'h-[78vh] min-h-[34rem] rounded-none border-0'}
                showLegend={false}
              />

              <div
                className={cx(
                  'pointer-events-none absolute inset-x-0 top-0 z-[520] bg-gradient-to-b from-slate-950/90 via-slate-950/45 to-transparent px-4 pb-16',
                  mobileImmersiveMode ? 'pt-[calc(env(safe-area-inset-top)+1rem)]' : 'pt-4'
                )}
              >
                <div className="pointer-events-auto flex items-start justify-between gap-3">
                  <div>
                    <p className="inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80">
                      Step 1 of 3
                    </p>
                    <p className="mt-2 font-['Outfit'] text-[1.85rem] font-semibold text-white">Capture walk</p>
                    {draftId ? (
                      <p className="mt-2 text-sm text-white/75">Saved draft linked. Resume, review, or keep recording.</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobileImmersiveMode((current) => !current)}
                    title={mobileImmersiveMode ? 'Return to normal layout' : 'Open fullscreen layout'}
                    aria-label={mobileImmersiveMode ? 'Return to normal layout' : 'Open fullscreen layout'}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition hover:bg-white/20"
                  >
                    <MobileImmersiveToggleIcon immersive={mobileImmersiveMode} />
                  </button>
                </div>
              </div>

              <div
                className={cx(
                  'z-[520]',
                  mobileImmersiveMode
                    ? 'absolute inset-x-0 bottom-0 px-3 pb-[calc(env(safe-area-inset-bottom)+0.6rem)]'
                    : 'relative -mt-8 px-0'
                )}
              >
                <div className="overflow-hidden rounded-[30px] border border-slate-200 bg-white/98 shadow-[0_-24px_60px_rgba(15,23,42,0.32)] backdrop-blur">
                  <div className={cx('overflow-y-auto px-4 pb-4 pt-4', mobileImmersiveMode ? 'max-h-[45dvh]' : undefined)}>
                    {recoveredInterruptedSession ? (
                      <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        Recovered paused session. Resume when you are ready, or stop to move into review.
                      </div>
                    ) : null}

                    {gpsError ? (
                      <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                        {gpsError}
                      </div>
                    ) : null}

                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Live recorder</p>
                      <p className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-950">{recordingPhaseLabel(recordingPhase)}</p>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{mobileCaptureStatusText}</p>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <div className="rounded-2xl bg-slate-950 px-3 py-3 text-white">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65">Time</p>
                        <p className="mt-1 font-['Outfit'] text-lg font-semibold">
                          {formatDuration(Math.round(effectiveElapsedMs / 1000))}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-slate-100 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Distance</p>
                        <p className="mt-1 font-['Outfit'] text-lg font-semibold text-slate-950">{formatMeters(routeDistanceM)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-100 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">GPS</p>
                        <p className="mt-1 font-['Outfit'] text-lg font-semibold text-slate-950">
                          {accuracySampleCount > 0 ? formatMeters(averageAccuracyM) : '-'}
                        </p>
                      </div>
                    </div>

                    {recordingPhase === 'recording' ? (
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setMobileCaptureActionsOpen(false);
                            transitionOutOfRecording('paused');
                          }}
                          disabled={saving}
                          className="rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Pause
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMobileCaptureActionsOpen(false);
                            handleStopRecording();
                          }}
                          disabled={saving}
                          className="rounded-full border border-slate-300 bg-white px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Stop
                        </button>
                      </div>
                    ) : recordingPhase === 'paused' ? (
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setMobileCaptureActionsOpen(false);
                            startRecording();
                          }}
                          disabled={saving}
                          className="rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Resume recording
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMobileCaptureActionsOpen(false);
                            handleStopRecording();
                          }}
                          disabled={saving}
                          className="rounded-full border border-slate-300 bg-white px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Stop
                        </button>
                      </div>
                    ) : canOpenReview && recordingPhase === 'stopped' ? (
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => {
                            setMobileCaptureActionsOpen(false);
                            handleOpenReview();
                          }}
                          disabled={saving}
                          className="w-full rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Review walk
                        </button>
                      </div>
                    ) : (
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => {
                            setMobileCaptureActionsOpen(false);
                            startRecording();
                          }}
                          disabled={saving}
                          className="w-full rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {recordingActionLabel}
                        </button>
                      </div>
                    )}

                    {hasMobileSecondaryCaptureActions ? (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => setMobileCaptureActionsOpen((current) => !current)}
                          disabled={saving}
                          className="w-full rounded-full border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {mobileCaptureActionsOpen ? 'Hide secondary actions' : 'More actions'}
                        </button>
                      </div>
                    ) : null}

                    {mobileCaptureActionsOpen && hasMobileSecondaryCaptureActions ? (
                      <div className="mt-3 space-y-2 rounded-[24px] border border-slate-200 bg-slate-50 px-3 py-3">
                        {canResumeStoppedCapture ? (
                          <button
                            type="button"
                            onClick={startRecording}
                            disabled={saving}
                            className="w-full rounded-full border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Continue recording
                          </button>
                        ) : null}
                        {canOpenSavedDrafts ? (
                          <button
                            type="button"
                            onClick={() => onViewChange('drafts')}
                            disabled={saving}
                            className="w-full rounded-full border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Open drafts
                          </button>
                        ) : null}
                        {hasDiscardableLocalSession ? (
                          <button
                            type="button"
                            onClick={resetRecordingDraft}
                            disabled={saving}
                            className="w-full rounded-full border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Discard local session
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="hidden gap-5 sm:grid xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)]">
              <div className="space-y-4">
                <RoutePreviewMap
                  routingDataset={routingDataset}
                  locationsDataset={locationsDataset}
                  candidates={[]}
                  draftGeometry={draftGeometry}
                  draftPoints={points}
                  livePoint={currentMapPoint}
                  liveAccuracyM={currentMapAccuracyM}
                  liveHeadingDeg={currentMapHeadingDeg}
                  liveSpeedMps={currentMapSpeedMps}
                  autoFrameKey={recordingAutoFrameKey}
                />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Points" value={points.length} />
                <MetricCard label="Walk length" value={formatMeters(routeDistanceM)} />
                <MetricCard label="Recorded time" value={formatDuration(Math.round(effectiveElapsedMs / 1000))} />
                <MetricCard
                  label="Avg. accuracy"
                  value={accuracySampleCount > 0 ? formatMeters(averageAccuracyM) : '-'}
                  hint={lastAccuracyM ? `Last fix ${formatMeters(lastAccuracyM)}` : undefined}
                />
              </div>
            </div>

            <div className="space-y-4 rounded-[28px] border border-slate-200 bg-white px-5 py-5 xl:sticky xl:top-24">
              <RouteLifecycleStrip stage={recordingLifecycleStage} />
              <div className="flex flex-wrap items-center gap-2">
                <AdminStatusBadge tone="default">Recorded by admin</AdminStatusBadge>
                <AdminStatusBadge>{clientConfig.campus_id}</AdminStatusBadge>
                <AdminStatusBadge tone={recordingPhaseTone(recordingPhase)}>
                  {recordingPhaseLabel(recordingPhase)}
                </AdminStatusBadge>
                <AdminStatusBadge tone={gpsStatusTone(gpsStatus)}>{gpsStatusLabel(gpsStatus)}</AdminStatusBadge>
                {draftId ? <AdminStatusBadge tone="info">Saved to drafts</AdminStatusBadge> : <AdminStatusBadge>Not live yet</AdminStatusBadge>}
                <AdminStatusBadge>{draftStatusLabel}</AdminStatusBadge>
              </div>

              {recoveredInterruptedSession ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  This walk was recovered from a paused or interrupted session. Resume when you are ready, or stop to move it into review.
                </div>
              ) : null}

              {gpsError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {gpsError}
                </div>
              ) : null}

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Live capture</p>
                <p className="mt-2 font-['Outfit'] text-3xl font-semibold text-slate-950">{recordingPhaseLabel(recordingPhase)}</p>
                <p className="mt-2 text-sm text-slate-600">
                  {lastFixLabel} Current path length after simplify and snap: {formatMeters(preparedRouteDistanceM)}.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {recordingPhase !== 'recording' ? (
                  <button
                    type="button"
                    onClick={startRecording}
                    disabled={saving}
                    className="rounded-full bg-slate-950 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {recordingActionLabel}
                  </button>
                ) : null}
                {canPauseCapture ? (
                  <button
                    type="button"
                    onClick={() => transitionOutOfRecording('paused')}
                    disabled={saving}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Pause
                  </button>
                ) : null}
                {canStopCapture ? (
                  <button
                    type="button"
                    onClick={handleStopRecording}
                    disabled={saving}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Stop
                  </button>
                ) : null}
                {canOpenReview ? (
                  <button
                    type="button"
                    onClick={handleOpenReview}
                    disabled={saving}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Review walk
                  </button>
                ) : null}
              </div>

              {canOpenSavedDrafts || hasDiscardableLocalSession ? (
                <div className="flex flex-wrap items-center gap-2">
                  {canOpenSavedDrafts ? (
                    <button
                      type="button"
                      onClick={() => onViewChange('drafts')}
                      disabled={saving}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Saved drafts
                    </button>
                  ) : null}
                  {hasDiscardableLocalSession ? (
                    <button
                      type="button"
                      onClick={resetRecordingDraft}
                      disabled={saving}
                      className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Discard local session
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            </div>
          </>
        ) : null}

        {activeView === 'drafts' ? (
          <div className="space-y-5">
            {hasAnyPath ? (
              <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Current local session</p>
                    <p className="mt-2 font-['Outfit'] text-2xl font-semibold text-slate-950">
                      {title.trim() || routeName.trim() || 'Untitled walk'}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone="default">Recorded by admin</AdminStatusBadge>
                      <AdminStatusBadge>{clientConfig.campus_id}</AdminStatusBadge>
                      {draftId ? <AdminStatusBadge tone="info">Saved draft linked</AdminStatusBadge> : <AdminStatusBadge>Local only</AdminStatusBadge>}
                    </div>
                    <p className="mt-2 text-sm text-slate-600">
                      {formatMeters(routeDistanceM)} across {points.length} points, updated {updatedAtLabel}.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canOpenReview ? (
                      <button
                        type="button"
                        onClick={handleOpenReview}
                        disabled={saving}
                        className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Open in review
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleContinueRecording}
                      disabled={saving}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Continue in capture
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Saved walk drafts</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Reopen a previously saved walk in review, or send it back into live capture.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onViewChange('capture')}
                    disabled={saving}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Back to capture
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void loadRecentDrafts({ notifyOnError: true });
                    }}
                    disabled={saving || loadingRecentDrafts}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingRecentDrafts ? 'Refreshing...' : 'Refresh drafts'}
                  </button>
                </div>
              </div>

              {loadingRecentDrafts && recentDrafts.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">Loading saved drafts...</p>
              ) : null}

              {!loadingRecentDrafts && recentDrafts.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6">
                  <AdminEmptyState
                    title="No saved drafts yet"
                    message="Stop and save a recording from Review, then reopen it here later."
                  />
                </div>
              ) : null}

              {recentDrafts.length > 0 ? (
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {recentDrafts.map((candidate) => {
                     const candidateDistanceM = computePathDistance(geometryToPoints(candidate.geometry));
                     const isLoaded = candidate.id === draftId;
                     const pendingCleanupCount = readPendingCleanupIssues(candidate).length;

                     return (
                      <div
                        key={candidate.id}
                        className={cx(
                          'rounded-2xl border px-4 py-4 transition',
                          isLoaded ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-slate-50'
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <AdminStatusBadge tone="info">Draft</AdminStatusBadge>
                          <AdminStatusBadge tone={sourceTone(candidate.source)}>{sourceLabel(candidate.source)}</AdminStatusBadge>
                          <AdminStatusBadge>{candidate.campusId}</AdminStatusBadge>
                          <AdminStatusBadge>{formatMeters(candidateDistanceM)}</AdminStatusBadge>
                          <AdminStatusBadge>{formatDuration(candidate.averageDurationS)}</AdminStatusBadge>
                          {pendingCleanupCount > 0 ? <AdminStatusBadge tone="warning">Cleanup suggested</AdminStatusBadge> : null}
                          {isLoaded ? <AdminStatusBadge tone="success">Loaded</AdminStatusBadge> : null}
                        </div>
                        <p className="mt-3 font-medium text-slate-950">{candidateDisplayTitle(candidate)}</p>
                        <p className="mt-1 text-sm text-slate-600">
                          Saved {formatSharedRelativeTime(candidate.updatedAt)}. Status {candidate.status}.
                          {pendingCleanupCount > 0
                            ? ` ${pendingCleanupCount} cleanup suggestion${pendingCleanupCount === 1 ? '' : 's'} saved with this draft.`
                            : ''}
                        </p>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          {recordingPhase !== 'recording' ? (
                            <>
                              <button
                                type="button"
                                onClick={() => loadDraftIntoRecorder(candidate, 'review')}
                                disabled={saving}
                                className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Open in review
                              </button>
                              <button
                                type="button"
                                onClick={() => loadDraftIntoRecorder(candidate, 'capture')}
                                disabled={saving}
                                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Continue in capture
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void handleDeleteServerDraft(candidate);
                                }}
                                disabled={saving}
                                className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Delete server draft
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeView === 'review' ? (
          hasAnyPath ? (
            <>
              <div className={cx('sm:hidden', mobileImmersiveMode ? 'fixed inset-0 z-[45]' : 'relative')}>
                <div className="relative">
                  <RoutePreviewMap
                    routingDataset={routingDataset}
                    locationsDataset={locationsDataset}
                    candidates={[]}
                    draftGeometry={draftGeometry}
                    previewGeometries={previewCleanupIssues.map((issue) => issue.proposedGeometry)}
                    draftPoints={points}
                    livePoint={currentMapPoint}
                    liveAccuracyM={currentMapAccuracyM}
                    liveHeadingDeg={currentMapHeadingDeg}
                    liveSpeedMps={currentMapSpeedMps}
                    editable={canManuallyEdit}
                    onAppendPoint={appendPoint}
                    autoFrameKey={recordingAutoFrameKey}
                    className="rounded-none border-0 bg-slate-950 p-0"
                    mapClassName={
                      mobileImmersiveMode
                        ? 'h-[100dvh] min-h-[100dvh] rounded-none border-0'
                        : 'h-[46vh] min-h-[19rem] rounded-none border-0'
                    }
                    showLegend={false}
                  />

                  <div
                    className={cx(
                      'pointer-events-none absolute inset-x-0 top-0 z-[500] bg-gradient-to-b from-slate-950/85 via-slate-950/35 to-transparent px-4 pb-10',
                      mobileImmersiveMode ? 'pt-[calc(env(safe-area-inset-top)+1rem)]' : 'pt-4'
                    )}
                  >
                    <div className="pointer-events-auto flex items-start justify-between gap-3">
                      <div>
                        <p className="inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80">
                          Step 2 of 3
                        </p>
                        <p className="mt-2 font-['Outfit'] text-[1.75rem] font-semibold text-white">Review walk</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMobileImmersiveMode((current) => !current)}
                        title={mobileImmersiveMode ? 'Return to normal layout' : 'Open fullscreen layout'}
                        aria-label={mobileImmersiveMode ? 'Return to normal layout' : 'Open fullscreen layout'}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition hover:bg-white/20"
                      >
                        <MobileImmersiveToggleIcon immersive={mobileImmersiveMode} />
                      </button>
                    </div>
                  </div>
                </div>

                <div
                  className={cx(
                    'rounded-t-[32px] border-t border-slate-200 bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-5 shadow-[0_-20px_50px_rgba(15,23,42,0.18)]',
                    mobileImmersiveMode
                      ? 'absolute inset-x-0 bottom-0 z-[520] max-h-[58dvh] overflow-y-auto px-4'
                      : 'relative z-[510] -mt-6'
                  )}
                >
                  {gpsError ? (
                    <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                      {gpsError}
                    </div>
                  ) : null}

                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Summary</p>
                    <p className="mt-2 font-['Outfit'] text-[1.75rem] font-semibold text-slate-950">
                      {title.trim() || routeName.trim() || 'Recorded walk'}
                    </p>
                    <RouteLifecycleStrip stage={recordingLifecycleStage} className="mt-3" compact noWrap />
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone="default">Recorded by admin</AdminStatusBadge>
                      {draftId ? <AdminStatusBadge tone="info">Draft saved</AdminStatusBadge> : <AdminStatusBadge>Draft only</AdminStatusBadge>}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {clientConfig.campus_id} · Updated {updatedAtLabel} · {points.length} {points.length === 1 ? 'point' : 'points'} captured.
                    </p>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl bg-slate-950 px-3 py-3 text-white">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65">Distance</p>
                      <p className="mt-1 font-['Outfit'] text-lg font-semibold">{formatMeters(routeDistanceM)}</p>
                    </div>
                    <div className="rounded-2xl bg-slate-100 px-3 py-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Time</p>
                      <p className="mt-1 font-['Outfit'] text-lg font-semibold text-slate-950">
                        {formatDuration(Math.round(effectiveElapsedMs / 1000))}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-slate-100 px-3 py-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">GPS</p>
                      <p className="mt-1 font-['Outfit'] text-lg font-semibold text-slate-950">
                        {accuracySampleCount > 0 ? formatMeters(averageAccuracyM) : '-'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <RouteCleanupAssistantCard
                      metadata={cleanupMetadata}
                      onApplyIssue={handleApplyCleanupIssue}
                      onDismissIssue={handleDismissCleanupIssue}
                      onPreviewIssue={handlePreviewCleanupIssue}
                      previewIssueIds={previewCleanupIssueIds}
                      onApplyAllSafe={safeCleanupIssues.length > 0 ? handleApplyAllSafeCleanup : undefined}
                      compact
                    />
                  </div>

                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Quick cleanup</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{mobileReviewStatusText}</p>

                    {canToggleCorrectionMode ? (
                      <button
                        type="button"
                        onClick={() => setCorrectionMode((current) => !current)}
                        disabled={saving}
                        className={cx(
                          'mt-4 w-full rounded-full border px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-60',
                          correctionMode
                            ? 'border-sky-300 bg-sky-50 text-sky-900'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-950'
                        )}
                      >
                        {correctionMode ? 'Finish correction points' : 'Add correction points'}
                      </button>
                    ) : null}

                    {hasVisibleCleanupActions ? (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {canUndoDraftPoint ? (
                          <button
                            type="button"
                            onClick={undoLastPoint}
                            disabled={saving}
                            className="rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Undo
                          </button>
                        ) : null}
                        {canTrimDraftPath ? (
                          <button
                            type="button"
                            onClick={trimStartPoint}
                            disabled={saving}
                            className="rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Trim start
                          </button>
                        ) : null}
                        {canTrimDraftPath ? (
                          <button
                            type="button"
                            onClick={trimEndPoint}
                            disabled={saving}
                            className="rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Trim end
                          </button>
                        ) : null}
                        {canTrimDraftPath ? (
                          <button
                            type="button"
                            onClick={simplifyDraftPath}
                            disabled={saving}
                            className="rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Simplify
                          </button>
                        ) : null}
                        {canSnapDraftPath ? (
                          <button
                            type="button"
                            onClick={snapDraftEndpoints}
                            disabled={saving}
                            className="col-span-2 rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Snap endpoints
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-4 text-sm leading-6 text-slate-500">
                        Add a few more points to unlock cleanup tools for this draft.
                      </p>
                    )}
                  </div>

                  <div
                    className={cx(
                      'mt-5 border-t border-slate-100 pt-5',
                      mobileImmersiveMode ? 'sticky bottom-0 -mx-4 bg-white/98 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] backdrop-blur' : undefined
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setMobileReviewDetailsOpen((current) => !current)}
                      className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left"
                    >
                      <span>
                        <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Optional details</span>
                        <span className="mt-1 block text-sm text-slate-600">
                          Add naming and accessibility metadata for the desktop review workflow.
                        </span>
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
                        {mobileReviewDetailsOpen ? 'Hide' : 'Show'}
                      </span>
                    </button>

                    {mobileReviewDetailsOpen ? (
                      <div className="mt-4 space-y-4">
                        <label className="block">
                          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Candidate title
                          </span>
                          <input
                            type="text"
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            placeholder="North library shortcut"
                            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                          />
                        </label>

                        <label className="block">
                          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Published route name
                          </span>
                          <input
                            type="text"
                            value={routeName}
                            onChange={(event) => setRouteName(event.target.value)}
                            placeholder="Library connector"
                            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                          />
                        </label>

                        <div className="grid gap-3">
                          {ROUTE_BOOLEAN_FIELDS.map((field) => {
                            const active = routeProperties[field.key];

                            return (
                              <button
                                key={field.key}
                                type="button"
                                onClick={() =>
                                  setRouteProperties((current) => ({
                                    ...current,
                                    [field.key]: !current[field.key],
                                  }))
                                }
                                className={cx(
                                  'rounded-2xl border px-4 py-3 text-left transition',
                                  active
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                                )}
                              >
                                <p className="text-xs font-semibold uppercase tracking-[0.14em]">{field.label}</p>
                                <p className="mt-2 text-sm">{active ? 'Enabled' : 'Disabled'}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-5 border-t border-slate-100 pt-5">
                    {canPersist || saving ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void persistRecording(false);
                          }}
                          disabled={saving}
                          className="w-full rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {saving ? 'Saving draft...' : 'Save draft'}
                        </button>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Save this walk now. It stays in drafts until you send it to the queue from the desktop review workflow.
                        </p>
                      </>
                    ) : null}

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={handleContinueRecording}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Continue recording
                      </button>
                      <button
                        type="button"
                        onClick={() => onViewChange('drafts')}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Open drafts
                      </button>
                    </div>

                    {hasDiscardableLocalSession ? (
                      <button
                        type="button"
                        onClick={resetRecordingDraft}
                        disabled={saving}
                        className="mt-3 w-full rounded-full border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Discard local session
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="hidden gap-5 sm:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.95fr)]">
              <div className="space-y-4">
                <RoutePreviewMap
                  routingDataset={routingDataset}
                  locationsDataset={locationsDataset}
                  candidates={[]}
                  draftGeometry={draftGeometry}
                  previewGeometries={previewCleanupIssues.map((issue) => issue.proposedGeometry)}
                  draftPoints={points}
                  livePoint={currentMapPoint}
                  liveAccuracyM={currentMapAccuracyM}
                  liveHeadingDeg={currentMapHeadingDeg}
                  liveSpeedMps={currentMapSpeedMps}
                  editable={canManuallyEdit}
                  onAppendPoint={appendPoint}
                  autoFrameKey={recordingAutoFrameKey}
                />

                <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                  <RouteCleanupAssistantCard
                    metadata={cleanupMetadata}
                    onApplyIssue={handleApplyCleanupIssue}
                    onDismissIssue={handleDismissCleanupIssue}
                    onPreviewIssue={handlePreviewCleanupIssue}
                    previewIssueIds={previewCleanupIssueIds}
                    onApplyAllSafe={safeCleanupIssues.length > 0 ? handleApplyAllSafeCleanup : undefined}
                  />
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Cleanup tools</p>
                      <p className="mt-1 text-sm text-slate-600">
                        Basic cleanup only in this pass: undo, trim, simplify, snap, and optional correction points.
                      </p>
                    </div>
                    <AdminStatusBadge tone={correctionMode ? 'info' : 'default'}>
                      {correctionMode ? 'Correction mode on' : 'Correction mode off'}
                    </AdminStatusBadge>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {canToggleCorrectionMode ? (
                      <button
                        type="button"
                        onClick={() => setCorrectionMode((current) => !current)}
                        disabled={saving}
                        className={cx(
                          'rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-60',
                          correctionMode
                            ? 'border-sky-300 bg-sky-50 text-sky-900'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-950'
                        )}
                      >
                        {correctionMode ? 'Stop correcting' : 'Add correction points'}
                      </button>
                    ) : null}
                    {canUndoDraftPoint ? (
                      <button
                        type="button"
                        onClick={undoLastPoint}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Undo point
                      </button>
                    ) : null}
                    {canTrimDraftPath ? (
                      <button
                        type="button"
                        onClick={trimStartPoint}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Trim start
                      </button>
                    ) : null}
                    {canTrimDraftPath ? (
                      <button
                        type="button"
                        onClick={trimEndPoint}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Trim end
                      </button>
                    ) : null}
                    {canTrimDraftPath ? (
                      <button
                        type="button"
                        onClick={simplifyDraftPath}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Simplify path
                      </button>
                    ) : null}
                    {canSnapDraftPath ? (
                      <button
                        type="button"
                        onClick={snapDraftEndpoints}
                        disabled={saving}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Snap endpoints
                      </button>
                    ) : null}
                  </div>

                  <p className="mt-4 text-sm text-slate-600">
                    {!hasVisibleCleanupActions
                      ? 'Add a few more points to unlock cleanup tools for this draft.'
                      : correctionMode
                      ? 'Tap the map to append correction points to the end of the recorded walk.'
                      : 'Turn on correction mode if you need to append cleanup points directly on the map.'}
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminStatusBadge tone={recordingPhaseTone(recordingPhase)}>
                      {recordingPhaseLabel(recordingPhase)}
                    </AdminStatusBadge>
                    <AdminStatusBadge tone={gpsStatusTone(gpsStatus)}>{gpsStatusLabel(gpsStatus)}</AdminStatusBadge>
                    {draftId ? <AdminStatusBadge tone="info">Server draft linked</AdminStatusBadge> : <AdminStatusBadge>Local draft only</AdminStatusBadge>}
                    <AdminStatusBadge>{draftStatusLabel}</AdminStatusBadge>
                  </div>

                  {gpsError ? (
                    <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                      {gpsError}
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <MetricCard label="Points" value={points.length} />
                    <MetricCard label="Walk length" value={formatMeters(routeDistanceM)} />
                    <MetricCard label="Recorded time" value={formatDuration(Math.round(effectiveElapsedMs / 1000))} />
                    <MetricCard
                      label="Avg. accuracy"
                      value={accuracySampleCount > 0 ? formatMeters(averageAccuracyM) : '-'}
                      hint={lastAccuracyM ? `Last fix ${formatMeters(lastAccuracyM)}` : undefined}
                    />
                  </div>

                  <p className="mt-4 text-sm text-slate-600">
                    Updated {updatedAtLabel}. Current draft path length: {formatMeters(preparedRouteDistanceM)}.
                  </p>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Candidate title
                      </span>
                      <input
                        type="text"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="North library shortcut"
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Published route name
                      </span>
                      <input
                        type="text"
                        value={routeName}
                        onChange={(event) => setRouteName(event.target.value)}
                        placeholder="Library connector"
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      />
                    </label>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {ROUTE_BOOLEAN_FIELDS.map((field) => {
                      const active = routeProperties[field.key];

                      return (
                        <button
                          key={field.key}
                          type="button"
                          onClick={() =>
                            setRouteProperties((current) => ({
                              ...current,
                              [field.key]: !current[field.key],
                            }))
                          }
                          className={cx(
                            'rounded-2xl border px-4 py-3 text-left transition',
                            active
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                              : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                          )}
                        >
                          <p className="text-xs font-semibold uppercase tracking-[0.14em]">{field.label}</p>
                          <p className="mt-2 text-sm">{active ? 'Enabled' : 'Disabled'}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-white px-5 py-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleContinueRecording}
                      disabled={saving}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Continue recording
                    </button>
                    {canPersist || saving ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void persistRecording(false);
                          }}
                          disabled={saving}
                          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {saving ? 'Working...' : 'Save draft'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void persistRecording(true);
                          }}
                          disabled={saving}
                          className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {saving ? 'Working...' : 'Send to queue'}
                        </button>
                      </>
                    ) : null}
                    {hasDiscardableLocalSession ? (
                      <button
                        type="button"
                        onClick={resetRecordingDraft}
                        disabled={saving}
                        className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Discard local session
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              </div>
            </>
          ) : (
            <div className="rounded-[28px] border border-dashed border-slate-300 bg-slate-50 px-4 py-8">
              <AdminEmptyState
                title="Nothing to review yet"
                message="Stop a live walk or open a saved draft to enter review."
              />
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => onViewChange('capture')}
                  className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800"
                >
                  Go to capture
                </button>
                <button
                  type="button"
                  onClick={() => onViewChange('drafts')}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                >
                  Browse drafts
                </button>
              </div>
            </div>
          )
        ) : null}
      </div>
    </AdminSectionCard>
  );
};

export default function AdminRouteWorkflowsPage({
  enabled,
  onWorkspaceRefresh,
}: AdminRouteWorkflowsPageProps): JSX.Element {
  const { showError, showWarning } = useToast();
  const [routingDataset, setRoutingDataset] = useState<MapDatasetRecord<MapFeatureCollection> | null>(null);
  const [locationsDataset, setLocationsDataset] = useState<MapDatasetRecord<MapFeatureCollection> | null>(null);
  const [loadingDataset, setLoadingDataset] = useState(false);
  const [candidateReloadToken, setCandidateReloadToken] = useState(0);
  const [activeView, setActiveView] = useState<RouteWorkflowView>('capture');
  const [recordingView, setRecordingView] = useState<RouteRecordingView>('capture');
  const [queueFocusCandidateId, setQueueFocusCandidateId] = useState<string | null>(null);

  const readPreviewDataset = useCallback(async (
    datasetType: 'locations' | 'routing'
  ): Promise<{
    dataset: MapDatasetRecord<MapFeatureCollection> | null;
    usedCache: boolean;
    error: Error | null;
  }> => {
    try {
      const dataset = await fetchPublicMapDataset<MapFeatureCollection>(datasetType);
      await writeCachedMapDataset(dataset);
      return {
        dataset,
        usedCache: false,
        error: null,
      };
    } catch (error) {
      const cachedDataset = await readCachedMapDataset<MapFeatureCollection>(datasetType);
      if (cachedDataset) {
        return {
          dataset: cachedDataset,
          usedCache: true,
          error: error instanceof Error ? error : new Error(`Unable to load ${datasetType} dataset.`),
        };
      }

      return {
        dataset: null,
        usedCache: false,
        error: error instanceof Error ? error : new Error(`Unable to load ${datasetType} dataset.`),
      };
    }
  }, []);

  const hydratePreviewDatasets = useCallback(async (): Promise<void> => {
    setLoadingDataset(true);

    try {
      const [nextRoutingDataset, nextLocationsDataset] = await Promise.all([
        readPreviewDataset('routing'),
        readPreviewDataset('locations'),
      ]);

      setRoutingDataset(nextRoutingDataset.dataset);
      setLocationsDataset(nextLocationsDataset.dataset);

      if (nextRoutingDataset.usedCache) {
        showWarning('Live routing data could not be reached, so a cached graph is being used for preview.', {
          title: 'Route workflows',
          dedupeKey: 'route-workflows-routing-cache',
        });
      } else if (!nextRoutingDataset.dataset && nextRoutingDataset.error) {
        showError(nextRoutingDataset.error.message, {
          title: 'Route workflows',
          dedupeKey: 'route-workflows-routing-load',
        });
      }

      if (nextLocationsDataset.usedCache) {
        showWarning('Live location data could not be reached, so a cached campus map is being used for preview.', {
          title: 'Route workflows',
          dedupeKey: 'route-workflows-locations-cache',
        });
      } else if (!nextLocationsDataset.dataset && nextLocationsDataset.error) {
        showError(nextLocationsDataset.error.message, {
          title: 'Route workflows',
          dedupeKey: 'route-workflows-locations-load',
        });
      }
    } finally {
      setLoadingDataset(false);
    }
  }, [readPreviewDataset, showError, showWarning]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void hydratePreviewDatasets();
  }, [enabled, hydratePreviewDatasets]);

  const handleRoutingPublished = async (
    result: MapDatasetMutationRecord<MapFeatureCollection>,
    overlay: RoutingWeightOverlayRecord
  ): Promise<void> => {
    setRoutingDataset(result.dataset);
    await writeCachedMapDataset(result.dataset);
    publishMapDatasetUpdated(result.dataset);
    writeCachedRoutingWeightOverlay(overlay);
    publishRoutingWeightOverlayUpdated(overlay);
    await onWorkspaceRefresh();
  };

  const handleCandidateChanged = useCallback((): void => {
    setCandidateReloadToken((current) => current + 1);
    void onWorkspaceRefresh();
  }, [onWorkspaceRefresh]);

  const handleRecordingSubmitted = useCallback(
    (candidateId: string): void => {
      setCandidateReloadToken((current) => current + 1);
      setQueueFocusCandidateId(candidateId);
      setActiveView('queue');
      void onWorkspaceRefresh();
    },
    [onWorkspaceRefresh]
  );

  const handleWorkspaceViewChange = useCallback((nextView: RouteWorkflowView): void => {
    if (nextView === 'queue' || nextView === 'published') {
      if (nextView !== 'queue') {
        setQueueFocusCandidateId(null);
      }
      setActiveView(nextView);
      return;
    }

    setQueueFocusCandidateId(null);
    setRecordingView(nextView);
    setActiveView(nextView);
  }, []);

  const handleRecordingViewChange = useCallback((nextView: RouteRecordingView): void => {
    setRecordingView(nextView);
    setActiveView(nextView);
  }, []);

  if (!enabled) {
    return (
      <AdminSectionCard label="Route workflows" title="Route operations are locked">
        <AdminEmptyState
          title="Admin access required"
          message="Sign in to review candidate paths, publish routes, or save manual recordings."
        />
      </AdminSectionCard>
    );
  }

  return (
    <div
      className={cx(
        'space-y-5 pb-28',
        activeView === 'capture' || activeView === 'review' ? 'space-y-0 pb-0 sm:space-y-5 sm:pb-28' : undefined
      )}
    >
      <div
        className={cx(
          'flex flex-wrap items-start justify-between gap-4',
          activeView === 'capture' || activeView === 'review' ? 'hidden sm:flex' : undefined
        )}
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">Route workflows</p>
          <h2 className="mt-2 font-['Outfit'] text-3xl font-semibold text-slate-950">Routing curation</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {routingDataset ? (
              <>
                <AdminStatusBadge tone="info">Routing dataset</AdminStatusBadge>
                <AdminStatusBadge>{routingDataset.collection.features.length} feature(s)</AdminStatusBadge>
                <AdminStatusBadge>{formatSharedRelativeTime(routingDataset.updatedAt)}</AdminStatusBadge>
              </>
            ) : (
              <AdminStatusBadge tone="warning">Routing preview unavailable</AdminStatusBadge>
            )}
            {locationsDataset ? (
              <>
                <AdminStatusBadge>Locations dataset</AdminStatusBadge>
                <AdminStatusBadge>{locationsDataset.collection.features.length} feature(s)</AdminStatusBadge>
                <AdminStatusBadge>{formatSharedRelativeTime(locationsDataset.updatedAt)}</AdminStatusBadge>
              </>
            ) : (
              <AdminStatusBadge tone="warning">Locations context unavailable</AdminStatusBadge>
            )}
            {loadingDataset ? <AdminStatusBadge>Refreshing datasets</AdminStatusBadge> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void hydratePreviewDatasets();
          }}
          disabled={loadingDataset}
          className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loadingDataset ? 'Refreshing...' : 'Refresh map datasets'}
        </button>
      </div>

      <div
        className={cx(
          'hidden gap-2 rounded-[28px] border border-slate-200 bg-white p-2 sm:grid sm:grid-cols-5'
        )}
      >
        {ROUTE_WORKFLOW_TABS.map((tab) => {
          const isActive = activeView === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleWorkspaceViewChange(tab.id)}
              className={cx(
                'rounded-[22px] px-4 py-3 text-left transition',
                isActive ? 'bg-slate-950 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-100'
              )}
            >
              <p className="text-sm font-semibold">{tab.label}</p>
              <p className={cx('mt-1 text-xs', isActive ? 'text-white/75' : 'text-slate-500')}>{tab.hint}</p>
            </button>
          );
        })}
      </div>

      <div className={cx(activeView === 'queue' || activeView === 'published' ? 'hidden' : 'block')}>
        <AdminRouteRecordingPanel
          routingDataset={routingDataset}
          locationsDataset={locationsDataset}
          onCandidateChanged={handleCandidateChanged}
          onSubmittedToQueue={handleRecordingSubmitted}
          activeView={recordingView}
          onViewChange={handleRecordingViewChange}
        />
      </div>

      <div className={cx(activeView === 'queue' || activeView === 'published' ? 'block sm:hidden' : 'hidden')}>
        <AdminSectionCard label="Desktop only" title="Approvals stay on desktop">
          <AdminEmptyState
            title={activeView === 'published' ? 'Published history is on desktop' : 'Queue review is on desktop'}
            message="Use Capture, Review, and Drafts on your phone. Open this workspace on desktop for approval and published-route history."
          />
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => handleWorkspaceViewChange('capture')}
              className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800"
            >
              Back to capture
            </button>
            <button
              type="button"
              onClick={() => handleWorkspaceViewChange('drafts')}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
            >
              Open drafts
            </button>
          </div>
        </AdminSectionCard>
      </div>

      <div className={cx(activeView === 'queue' ? 'hidden sm:block' : 'hidden')}>
        <AdminRouteCandidateReviewPanel
          routingDataset={routingDataset}
          locationsDataset={locationsDataset}
          mode="queue"
          focusCandidateId={queueFocusCandidateId}
          reloadToken={candidateReloadToken}
          onActivityChanged={() => {
            void onWorkspaceRefresh();
          }}
          onRoutingPublished={handleRoutingPublished}
        />
      </div>

      <div className={cx(activeView === 'published' ? 'hidden sm:block' : 'hidden')}>
        <AdminRouteCandidateReviewPanel
          routingDataset={routingDataset}
          locationsDataset={locationsDataset}
          mode="published"
          reloadToken={candidateReloadToken}
          onActivityChanged={() => {
            void onWorkspaceRefresh();
          }}
          onRoutingPublished={handleRoutingPublished}
        />
      </div>
    </div>
  );
}
