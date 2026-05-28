import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { useToast } from '../../context/ToastContext';
import { clientConfig } from '../../config/client';
import {
  featureContainsPoint,
  featureDistanceToPointMeters,
  isOpenAreaFeature,
  toLngLat as toMapLngLat,
} from '../../core/geoGeometry';
import { withInferredLocationEntrances } from '../../core/routingEntranceInference';
import { isEmptyRoutingGraph, validateRoutingGraph, type CampusRoutingGraph } from '../../core/routingGraph';
import { writeCachedMapDataset } from '../../services/mapDatasetCache';
import { publishMapDatasetUpdated } from '../../services/mapDatasetEvents';
import {
  bulkImportAdminMapBundle,
  bulkDeleteAdminMapDatasetFeatures,
  bulkUpsertAdminMapDataset,
  createAdminMapFeature,
  deleteAdminMapFeature,
  fetchAdminMapDataset,
  fetchAdminMapDatasetRevisions,
  restoreAdminMapDatasetRevision,
  updateAdminMapFeature,
  type MapDatasetBundleInput,
  type MapDatasetMutationRecord,
  type MapDatasetRecord,
  type MapDatasetRevisionRecord,
  type MapDatasetType,
  type MapDatasetImportOptions,
  type MapFeatureCollection,
} from '../../services/mapDatasets';
import { PanelSkeleton } from '../LoadingPrimitives';
import { ConfirmationModal, SearchInput } from './AdminOpsComponents';
import { formatAbsoluteTime, formatDatasetLabel, formatRelativeTime, type AdminDatasetManagerFocusRequest } from './adminWorkspace';
import AdminFeatureGeometryEditor from './AdminFeatureGeometryEditor';
import { AdminEmptyState, AdminSectionCard, AdminStatCard, AdminStatusBadge, cx } from './AdminUi';

type EditableFeature = Feature<Geometry, Record<string, unknown>>;
type EditableGeometryType = 'Point' | 'LineString' | 'Polygon';
type DatasetIntent = 'edit-existing' | 'create-new';
type DatasetView = 'landing' | 'wizard' | 'utilities';
type UtilityView = 'import' | 'coverage' | 'delete' | 'history' | 'raw-json';
type WizardStep = 0 | 1 | 2 | 3;

interface AdminDatasetManagerPageProps {
  enabled: boolean;
  onLocationsChanged: () => Promise<void>;
  pendingFocusRequest?: AdminDatasetManagerFocusRequest | null;
  onConsumeFocusRequest?: () => void;
}

interface GeometryOption {
  value: EditableGeometryType;
  label: string;
  description: string;
}

interface PendingTransitionState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  action:
    | { kind: 'landing' }
    | { kind: 'intent'; nextIntent: DatasetIntent }
    | { kind: 'dataset'; nextDatasetType: MapDatasetType }
    | { kind: 'open-feature'; nextDatasetType: MapDatasetType; feature: EditableFeature }
    | { kind: 'utilities'; nextUtilityView: UtilityView };
}

interface PendingActionState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  action:
    | { kind: 'delete-feature' }
    | { kind: 'bulk-delete' }
    | { kind: 'delete-linked-access-point'; featureId: string; label: string }
    | { kind: 'delete-linked-connector'; featureId: string; label: string }
    | { kind: 'import'; collection: MapFeatureCollection; importOptions?: MapDatasetImportOptions | null }
    | { kind: 'import-bundle'; bundle: MapDatasetBundleInput<MapFeatureCollection>; importOptions?: MapDatasetImportOptions | null }
    | { kind: 'restore'; revision: MapDatasetRevisionRecord };
}

interface LocationImportSetupState {
  fileName: string;
  collection: MapFeatureCollection;
  missingTypeCount: number;
  candidateFields: string[];
  selectedSourceProperty: string;
}

interface LocationImportPreview {
  resolvedCollection: MapFeatureCollection;
  categoryCounts: Array<{ label: string; count: number }>;
  mappedFromSourceCount: number;
  fallbackCount: number;
}

interface BundleImportSetupState {
  fileName: string;
  bundle: MapDatasetBundleInput<MapFeatureCollection>;
  missingLocationTypeCount: number;
  locationCandidateFields: string[];
  selectedLocationSourceProperty: string;
}

interface RoutingImportSetupState {
  fileName: string;
  collection: MapFeatureCollection;
}

interface RoutingValidationPreview {
  errors: string[];
  warnings: string[];
  autoConnectedWarnings: string[];
  unreachableWarnings: string[];
  isEmptyGraph: boolean;
}

interface LocationAssociationOption {
  feature: EditableFeature;
  featureId: string;
  featureName: string;
  featureType: string;
  displayCode: string;
  label: string;
  centroid: [number, number];
  searchText: string;
}

interface AutoAssignedLocationResult {
  option: LocationAssociationOption;
  distanceMeters: number;
  source: 'containing' | 'nearest';
}

interface CoverageLocationIssue {
  feature: EditableFeature;
  locationId: string;
  explicitEntranceIds: string[];
  explicitConnectedEntranceIds: string[];
  effectiveEntranceIds: string[];
  effectiveConnectedEntranceIds: string[];
  heuristicConnectedNodeIds: string[];
  routingFeature: EditableFeature | null;
}

interface CoverageRoutingIssue {
  key: string;
  nodeId: string;
  title: string;
  description: string;
  routingFeature: EditableFeature | null;
  locationFeature: EditableFeature | null;
}

interface CoverageReport {
  polygonLocationCount: number;
  noExplicitEntrance: CoverageLocationIssue[];
  inferredOnly: CoverageLocationIssue[];
  indoorAccessMissing: CoverageLocationIssue[];
  heuristicOnly: CoverageLocationIssue[];
  noRoutableAccess: CoverageLocationIssue[];
  unmappedEntranceIssues: CoverageRoutingIssue[];
  unreachableEntranceIssues: CoverageRoutingIssue[];
  graphErrors: string[];
  graphWarnings: string[];
  partialGraph: boolean;
  combinedRoutingIssueCount: number;
  isEmptyGraph: boolean;
}

interface RoutingDeletePreview {
  deletedCount: number;
  validationErrors: string[];
  isEmptyGraph: boolean;
}

type AccessPointRole = 'entrance' | 'exit' | 'both';

interface LocationAccessPointRecord {
  feature: EditableFeature;
  featureId: string;
  nodeId: string;
  locationId: string;
  role: AccessPointRole;
  connected: boolean;
  missingLocationLink: boolean;
  title: string;
  connectorCount: number;
}

interface AccessPointConnectorRecord {
  feature: EditableFeature;
  featureId: string;
  title: string;
}

const locationTextFields = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'kind', label: 'Kind' },
  { key: 'short_code', label: 'Short code' },
  { key: 'campus_id', label: 'Campus id' },
  { key: 'status', label: 'Status' },
] as const;

const locationNumberFields = [
  { key: 'occupancy', label: 'Occupancy' },
  { key: 'floor_count', label: 'Floor count' },
] as const;

const ROUTING_ACCESS_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'open_area', label: 'Open area' },
  { value: 'entrance', label: 'Entrance-based' },
  { value: 'gate_only', label: 'Gate only' },
] as const;

const LOCATION_TYPE_OPTIONS = [
  { value: 'Location', label: 'Location' },
  { value: 'Building', label: 'Building' },
  { value: 'Academic', label: 'Academic' },
  { value: 'Administrative', label: 'Administrative' },
  { value: 'Hostel', label: 'Hostel' },
  { value: 'Hall', label: 'Hall' },
  { value: 'Library', label: 'Library' },
  { value: 'Laboratory', label: 'Laboratory' },
  { value: 'Cafeteria', label: 'Cafeteria' },
  { value: 'Clinic', label: 'Clinic' },
  { value: 'Parking', label: 'Parking' },
  { value: 'Field', label: 'Field' },
  { value: 'Garden', label: 'Garden' },
  { value: 'Fence', label: 'Fence' },
  { value: 'Compound', label: 'Compound' },
] as const;

const LOCATION_KIND_OPTIONS = [
  { value: 'location', label: 'Location' },
  { value: 'building', label: 'Building' },
  { value: 'open_area', label: 'Open area' },
  { value: 'fence', label: 'Fence' },
  { value: 'compound', label: 'Compound' },
] as const;

const LOCATION_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'under_construction', label: 'Under construction' },
  { value: 'restricted', label: 'Restricted' },
] as const;

const LOCATION_FEATURE_OPTIONS = [
  { value: 'wifi', label: 'Wi-Fi' },
  { value: 'power', label: 'Power' },
  { value: 'accessible', label: 'Accessible' },
  { value: 'parking', label: 'Parking' },
  { value: 'security', label: 'Security' },
  { value: 'water', label: 'Water' },
  { value: 'restroom', label: 'Restroom' },
  { value: 'study_area', label: 'Study area' },
  { value: 'fence', label: 'Fence' },
  { value: 'compound', label: 'Compound' },
] as const;

const routingTextFields = [
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind' },
  { key: 'node_id', label: 'Node id' },
  { key: 'location_id', label: 'Location id' },
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
  { key: 'highway', label: 'Highway', fullWidth: true },
] as const;

const routingBooleanFields = [
  { key: 'accessible', label: 'Accessible' },
  { key: 'stairs', label: 'Stairs' },
  { key: 'ramp', label: 'Ramp' },
  { key: 'elevator', label: 'Elevator' },
] as const;

const locationGeometryOptions: readonly GeometryOption[] = [
  { value: 'Point', label: 'Point', description: 'Pin or entrance.' },
  { value: 'LineString', label: 'Line', description: 'Path or corridor.' },
  { value: 'Polygon', label: 'Polygon', description: 'Area or boundary.' },
] as const;

const routingGeometryOptions: readonly GeometryOption[] = [
  { value: 'Point', label: 'Point', description: 'Routing node.' },
  { value: 'LineString', label: 'Line', description: 'Routing edge.' },
] as const;

const geometryOptionsByDataset: Record<MapDatasetType, readonly GeometryOption[]> = {
  locations: locationGeometryOptions,
  routing: routingGeometryOptions,
};

const wizardStepsByIntent: Record<DatasetIntent, readonly string[]> = {
  'edit-existing': ['Choose feature', 'Edit details', 'Edit geometry', 'Review'],
  'create-new': ['Choose geometry', 'Edit details', 'Edit geometry', 'Review'],
};

const utilityTabs: Array<{ id: UtilityView; label: string }> = [
  { id: 'import', label: 'Import' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'delete', label: 'Delete' },
  { id: 'history', label: 'History' },
  { id: 'raw-json', label: 'Raw JSON' },
];

const ACCESS_ROLE_OPTIONS: Array<{ value: AccessPointRole; label: string }> = [
  { value: 'entrance', label: 'Entrance' },
  { value: 'exit', label: 'Exit' },
  { value: 'both', label: 'Both' },
];

const ACCESS_POINT_NAME_PATTERN = /\b(entrance|gate|entry|exit|door)\b/i;

const ROUTING_LOCATION_NEAREST_MATCH_MAX_DISTANCE_METERS = 60;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const createGeometryTemplate = (geometryType: EditableGeometryType): Geometry => {
  if (geometryType === 'Point') {
    return {
      type: 'Point',
      coordinates: [clientConfig.map.center[1], clientConfig.map.center[0]],
    };
  }

  if (geometryType === 'LineString') {
    return {
      type: 'LineString',
      coordinates: [],
    };
  }

  return {
    type: 'Polygon',
    coordinates: [[]],
  };
};

const toFeatureId = (feature: { id?: unknown } | null | undefined): string => {
  if (typeof feature?.id === 'string') {
    return feature.id.trim();
  }

  if (typeof feature?.id === 'number' && Number.isFinite(feature.id)) {
    return String(feature.id);
  }

  return '';
};

const normalizeEditableFeature = (input: unknown, fallbackId?: string): EditableFeature => {
  const candidate = cloneJson(input);

  if (!isRecord(candidate) || candidate.type !== 'Feature') {
    throw new Error('Feature JSON must describe a GeoJSON Feature.');
  }

  const featureId = toFeatureId(candidate as { id?: unknown }) || fallbackId || '';
  if (!featureId) {
    throw new Error('Feature id is required.');
  }

  if (!isRecord(candidate.geometry)) {
    throw new Error('Feature geometry is required.');
  }

  return {
    ...(candidate as unknown as EditableFeature),
    id: featureId,
    properties: isRecord(candidate.properties) ? candidate.properties : {},
  };
};

const normalizeFeatureCollection = (input: unknown): MapFeatureCollection => {
  const candidate = cloneJson(input);

  if (!isRecord(candidate) || candidate.type !== 'FeatureCollection' || !Array.isArray(candidate.features)) {
    throw new Error('Upload must be a GeoJSON FeatureCollection.');
  }

  return {
    type: 'FeatureCollection',
    features: candidate.features.map((feature) => normalizeEditableFeature(feature)),
  } as FeatureCollection<Geometry, Record<string, unknown>>;
};

const normalizeDatasetBundleUpload = (input: unknown): MapDatasetBundleInput<MapFeatureCollection> => {
  const candidate = cloneJson(input);

  if (
    !isRecord(candidate) ||
    !('locations' in candidate) ||
    !('routing' in candidate) ||
    (typeof candidate.type === 'string' && candidate.type.trim() !== 'wia-dataset-bundle')
  ) {
    throw new Error('Bundle file must include both locations and routing FeatureCollections.');
  }

  return {
    type: 'wia-dataset-bundle',
    version:
      typeof candidate.version === 'number' && Number.isFinite(candidate.version)
        ? candidate.version
        : 1,
    locations: normalizeFeatureCollection(candidate.locations),
    routing: normalizeFeatureCollection(candidate.routing),
  };
};

const createEmptyFeature = (datasetType: MapDatasetType, geometryType: EditableGeometryType): EditableFeature => {
  if (datasetType === 'locations') {
    return {
      type: 'Feature',
      id: `location_${Date.now()}`,
      geometry: createGeometryTemplate(geometryType),
      properties: {
        name: geometryType === 'Polygon' ? 'New area' : geometryType === 'LineString' ? 'New path' : 'New location',
        type: geometryType === 'Polygon' ? 'Area' : geometryType === 'LineString' ? 'Path' : 'Location',
        campus_id: clientConfig.campus_id,
        features: [],
      },
    };
  }

  return {
    type: 'Feature',
    id: `routing_${Date.now()}`,
    geometry: createGeometryTemplate(geometryType),
    properties: {
      kind: geometryType === 'Point' ? 'node' : 'edge',
      accessible: true,
      stairs: false,
      ramp: false,
      elevator: false,
    },
  };
};

const featureSearchText = (feature: EditableFeature): string => {
  const properties = isRecord(feature.properties) ? feature.properties : {};
  const values = [
    feature.id,
    properties.name,
    properties.type,
    properties.kind,
    properties.node_id,
    readRoutingLocationAssociationId(properties),
    properties.from,
    properties.to,
    properties.highway,
  ];

  return values.filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
};

const featureTitle = (feature: EditableFeature): string => {
  const properties = isRecord(feature.properties) ? feature.properties : {};

  return (
    (typeof properties.name === 'string' && properties.name.trim()) ||
    (typeof properties.label === 'string' && properties.label.trim()) ||
    toFeatureId(feature)
  );
};

const featureSubtitle = (feature: EditableFeature): string => {
  const properties = isRecord(feature.properties) ? feature.properties : {};

  if (typeof properties.type === 'string' && properties.type.trim()) {
    return properties.type.trim();
  }

  if (typeof properties.kind === 'string' && properties.kind.trim()) {
    return properties.kind.trim();
  }

  return feature.geometry.type;
};

const featureMetaSummary = (datasetType: MapDatasetType, feature: EditableFeature): string => {
  const properties = isRecord(feature.properties) ? feature.properties : {};

  if (datasetType === 'locations') {
    const details = [
      typeof properties.status === 'string' && properties.status.trim() ? properties.status.trim() : null,
      typeof properties.campus_id === 'string' && properties.campus_id.trim() ? `Campus ${properties.campus_id.trim()}` : null,
      typeof properties.short_code === 'string' && properties.short_code.trim() ? properties.short_code.trim() : null,
    ].filter((value): value is string => Boolean(value));

    return details.length > 0 ? details.join(' / ') : 'Location';
  }

  const fromValue = typeof properties.from === 'string' && properties.from.trim() ? properties.from.trim() : '';
  const toValue = typeof properties.to === 'string' && properties.to.trim() ? properties.to.trim() : '';
  const locationId = readRoutingLocationAssociationId(properties);
  const details = [
    typeof properties.node_id === 'string' && properties.node_id.trim() ? `Node ${properties.node_id.trim()}` : null,
    fromValue && toValue ? `${fromValue} -> ${toValue}` : null,
    locationId ? `Location ${locationId}` : null,
  ].filter((value): value is string => Boolean(value));

  return details.length > 0 ? details.join(' / ') : 'Routing feature';
};

const stringifyFeature = (feature: EditableFeature | null): string => {
  return feature ? JSON.stringify(feature, null, 2) : '';
};

const parseStringList = (value: string): string[] => {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
};

const readTrimmedString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const readRoutingLocationAssociationId = (properties: Record<string, unknown>): string => {
  return (
    readTrimmedString(properties.location_id) ||
    readTrimmedString(properties.locationId) ||
    readTrimmedString(properties.building_id)
  );
};

const countLocationFeaturesMissingType = (collection: MapFeatureCollection): number => {
  return collection.features.reduce((count, feature) => {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    return readTrimmedString(properties.type) ? count : count + 1;
  }, 0);
};

const preferredImportFieldOrder = [
  'category',
  'classification',
  'building_type',
  'buildingType',
  'venue_type',
  'venueType',
  'class',
  'group',
  'kind',
  'label',
] as const;

const collectLocationTypeCandidateFields = (collection: MapFeatureCollection): string[] => {
  const counts = new Map<string, number>();

  collection.features.forEach((feature) => {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    if (readTrimmedString(properties.type)) {
      return;
    }

    Object.entries(properties).forEach(([key, value]) => {
      if (key === 'type' || !readTrimmedString(value)) {
        return;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort((left, right) => {
      const leftPreference = preferredImportFieldOrder.indexOf(left[0] as (typeof preferredImportFieldOrder)[number]);
      const rightPreference = preferredImportFieldOrder.indexOf(right[0] as (typeof preferredImportFieldOrder)[number]);
      const normalizedLeftPreference = leftPreference === -1 ? Number.MAX_SAFE_INTEGER : leftPreference;
      const normalizedRightPreference = rightPreference === -1 ? Number.MAX_SAFE_INTEGER : rightPreference;

      if (normalizedLeftPreference !== normalizedRightPreference) {
        return normalizedLeftPreference - normalizedRightPreference;
      }

      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([key]) => key);
};

const buildLocationImportPreview = (
  collection: MapFeatureCollection,
  selectedSourceProperty: string
): LocationImportPreview => {
  let mappedFromSourceCount = 0;
  let fallbackCount = 0;
  const categoryCounts = new Map<string, number>();

  const resolvedCollection = {
    ...collection,
    features: collection.features.map((feature) => {
      const properties = isRecord(feature.properties) ? feature.properties : {};
      const existingType = readTrimmedString(properties.type);

      if (existingType) {
        categoryCounts.set(existingType, (categoryCounts.get(existingType) ?? 0) + 1);
        return feature;
      }

      const mappedType = selectedSourceProperty
        ? readTrimmedString(properties[selectedSourceProperty])
        : '';
      const resolvedType = mappedType || 'Location';

      if (mappedType) {
        mappedFromSourceCount += 1;
      } else {
        fallbackCount += 1;
      }

      categoryCounts.set(resolvedType, (categoryCounts.get(resolvedType) ?? 0) + 1);

      return {
        ...feature,
        properties: {
          ...properties,
          type: resolvedType,
        },
      };
    }),
  } as MapFeatureCollection;

  return {
    resolvedCollection,
    categoryCounts: Array.from(categoryCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => {
        if (left.count !== right.count) {
          return right.count - left.count;
        }
        return left.label.localeCompare(right.label);
      }),
    mappedFromSourceCount,
    fallbackCount,
  };
};

const buildRoutingValidationPreview = (
  collection: MapFeatureCollection,
  locationsCollection?: MapFeatureCollection | null
): RoutingValidationPreview => {
  const result = validateRoutingGraph(collection, {
    strict: true,
    allowEmptyGraph: true,
    locations: locationsCollection ?? null,
  });
  const autoConnectedWarnings = result.warnings.filter((warning) =>
    warning.includes('was auto-connected to walkway node')
  );
  const unreachableWarnings = result.warnings.filter((warning) =>
    warning.includes('is not connected to a walkway segment within')
  );
  const isEmptyGraph =
    result.errors.length === 0 &&
    result.warnings.length === 0 &&
    isEmptyRoutingGraph(result.graph);

  return {
    errors: result.errors,
    warnings: result.warnings,
    autoConnectedWarnings,
    unreachableWarnings,
    isEmptyGraph,
  };
};

const withRoutingClearFallbackMessage = (message: string, isEmptyGraph: boolean): string => {
  if (!isEmptyGraph) {
    return message;
  }

  return `${message} This will clear the live routing dataset and users will fall back to direct routing until routes are republished.`;
};

const humanizeToken = (value: string): string => {
  return value
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const readFirstTrimmedProperty = (
  properties: Record<string, unknown>,
  keys: readonly string[]
): string => {
  for (const key of keys) {
    const value = readTrimmedString(properties[key]);
    if (value) {
      return value;
    }
  }

  return '';
};

const hasRoutingGeometry = (feature: EditableFeature): boolean => {
  if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    const kind = readTrimmedString(properties.kind).toLowerCase();
    return Boolean(
      readTrimmedString(properties.highway) ||
        kind === 'edge' ||
        readTrimmedString(properties.from) ||
        readTrimmedString(properties.to) ||
        readTrimmedString(properties.from_id) ||
        readTrimmedString(properties.to_id)
    );
  }

  if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint') {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    const kind = readTrimmedString(properties.kind).toLowerCase();
    return Boolean(
      readTrimmedString(properties.entrance) ||
      readTrimmedString(properties.node_id) ||
      readRoutingLocationAssociationId(properties) ||
      kind === 'node' ||
      kind === 'entrance'
    );
  }

  return false;
};

const hasLocationGeometry = (feature: EditableFeature): boolean => {
  if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
    return true;
  }

  if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint') {
    return !hasRoutingGeometry(feature);
  }

  return false;
};

const deriveImportedLocationType = (properties: Record<string, unknown>): string => {
  const existingType = readTrimmedString(properties.type);
  if (existingType) {
    return existingType;
  }

  const amenity = readTrimmedString(properties.amenity);
  if (amenity) {
    return humanizeToken(amenity);
  }

  const building = readTrimmedString(properties.building);
  if (building) {
    return building.toLowerCase() === 'yes' ? 'Building' : humanizeToken(building);
  }

  const fallbackType = readFirstTrimmedProperty(properties, [
    'category',
    'tourism',
    'leisure',
    'shop',
    'sport',
    'craft',
    'office',
  ]);

  return fallbackType ? humanizeToken(fallbackType) : 'Location';
};

const deriveImportedLocationName = (
  properties: Record<string, unknown>,
  derivedType: string
): string => {
  const explicitName = readFirstTrimmedProperty(properties, ['name', 'name_1', 'brand', 'operator']);
  if (explicitName) {
    return explicitName;
  }

  const amenity = readTrimmedString(properties.amenity);
  if (amenity) {
    return humanizeToken(amenity);
  }

  const building = readTrimmedString(properties.building);
  if (building) {
    return building.toLowerCase() === 'yes' ? derivedType : `${humanizeToken(building)} building`;
  }

  const fallbackName = readFirstTrimmedProperty(properties, [
    'category',
    'tourism',
    'leisure',
    'shop',
    'sport',
    'craft',
    'office',
  ]);

  return fallbackName ? humanizeToken(fallbackName) : derivedType;
};

const averageCoordinates = (coordinates: Array<[number, number]>): [number, number] | null => {
  if (coordinates.length === 0) {
    return null;
  }

  const { lng, lat } = coordinates.reduce(
    (accumulator, [coordinateLng, coordinateLat]) => ({
      lng: accumulator.lng + coordinateLng,
      lat: accumulator.lat + coordinateLat,
    }),
    { lng: 0, lat: 0 }
  );

  return [lng / coordinates.length, lat / coordinates.length];
};

const isPointGeometry = (feature: EditableFeature | null): boolean => {
  return Boolean(feature && (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint'));
};

const getFeaturePoint = (feature: EditableFeature | null): [number, number] | null => {
  if (!feature) {
    return null;
  }

  if (feature.geometry.type === 'Point') {
    return toMapLngLat(feature.geometry.coordinates);
  }

  if (feature.geometry.type === 'MultiPoint') {
    for (const coordinate of feature.geometry.coordinates) {
      const point = toMapLngLat(coordinate);
      if (point) {
        return point;
      }
    }
  }

  return null;
};

const featureCentroid = (feature: EditableFeature): [number, number] | null => {
  if (feature.geometry.type === 'Point') {
    return toMapLngLat(feature.geometry.coordinates);
  }

  if (feature.geometry.type === 'MultiPoint') {
    return averageCoordinates(
      feature.geometry.coordinates
        .map((coordinate) => toMapLngLat(coordinate))
        .filter((coordinate): coordinate is [number, number] => Boolean(coordinate))
    );
  }

  if (feature.geometry.type === 'Polygon') {
    const outerRing = Array.isArray(feature.geometry.coordinates[0]) ? feature.geometry.coordinates[0] : [];
    return averageCoordinates(
      outerRing
        .map((coordinate) => toMapLngLat(coordinate))
        .filter((coordinate): coordinate is [number, number] => Boolean(coordinate))
    );
  }

  if (feature.geometry.type === 'MultiPolygon') {
    const coordinates = feature.geometry.coordinates.flatMap((polygon) =>
      (Array.isArray(polygon[0]) ? polygon[0] : [])
        .map((coordinate) => toMapLngLat(coordinate))
        .filter((coordinate): coordinate is [number, number] => Boolean(coordinate))
    );
    return averageCoordinates(coordinates);
  }

  return null;
};

const haversineDistanceMeters = (from: [number, number], to: [number, number]): number => {
  const earthRadiusMeters = 6371000;
  const toRadians = (value: number): number => (value * Math.PI) / 180;
  const [fromLng, fromLat] = from;
  const [toLng, toLat] = to;
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getLocationAssociationDisplayCode = (feature: EditableFeature): string => {
  const properties = isRecord(feature.properties) ? feature.properties : {};
  return readFirstTrimmedProperty(properties, ['short_code', 'building_id', 'buildingId']);
};

const buildLocationAssociationOptions = (
  features: EditableFeature[]
): LocationAssociationOption[] => {
  return features
    .filter((feature) => hasLocationGeometry(feature))
    .map((feature) => {
      const featureId = toFeatureId(feature);
      const centroid = featureCentroid(feature);
      if (!featureId || !centroid) {
        return null;
      }

      const featureName = featureTitle(feature);
      const featureType = featureSubtitle(feature);
      const displayCode = getLocationAssociationDisplayCode(feature);
      const label = displayCode ? `${featureName} (${displayCode})` : featureName;
      const searchText = [
        featureId,
        featureName,
        featureType,
        displayCode,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return {
        feature,
        featureId,
        featureName,
        featureType,
        displayCode,
        label,
        centroid,
        searchText,
      };
    })
    .filter((option): option is LocationAssociationOption => Boolean(option))
    .sort((left, right) => {
      const labelComparison = left.label.localeCompare(right.label);
      if (labelComparison !== 0) {
        return labelComparison;
      }
      return left.featureId.localeCompare(right.featureId);
    });
};

const resolveContainingLocationAssociation = (
  point: [number, number],
  options: LocationAssociationOption[]
): AutoAssignedLocationResult | null => {
  const containingMatches = options
    .filter((option) => {
      return (
        (option.feature.geometry.type === 'Polygon' || option.feature.geometry.type === 'MultiPolygon') &&
        featureContainsPoint(option.feature, point)
      );
    })
    .map((option) => ({
      option,
      distanceMeters: haversineDistanceMeters(point, option.centroid),
      source: 'containing' as const,
    }))
    .sort((left, right) => {
      if (left.distanceMeters !== right.distanceMeters) {
        return left.distanceMeters - right.distanceMeters;
      }
      return left.option.label.localeCompare(right.option.label);
    });

  return containingMatches[0] ?? null;
};

const resolveNearestLocationAssociation = (
  point: [number, number],
  options: LocationAssociationOption[],
  maxDistanceMeters = ROUTING_LOCATION_NEAREST_MATCH_MAX_DISTANCE_METERS
): AutoAssignedLocationResult | null => {
  const nearestMatch = options
    .map((option) => ({
      option,
      distanceMeters: haversineDistanceMeters(point, option.centroid),
      source: 'nearest' as const,
    }))
    .sort((left, right) => {
      if (left.distanceMeters !== right.distanceMeters) {
        return left.distanceMeters - right.distanceMeters;
      }
      return left.option.label.localeCompare(right.option.label);
    })[0];

  if (!nearestMatch || nearestMatch.distanceMeters > maxDistanceMeters) {
    return null;
  }

  return nearestMatch;
};

const resolveLocationAssociationForPoint = (
  point: [number, number],
  options: LocationAssociationOption[]
): AutoAssignedLocationResult | null => {
  return resolveContainingLocationAssociation(point, options) ?? resolveNearestLocationAssociation(point, options);
};

const isPolygonLocationFeature = (feature: EditableFeature): boolean => {
  return feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
};

const nodeHasGraphConnection = (
  graph: CampusRoutingGraph | null | undefined,
  nodeId: string
): boolean => {
  return (graph?.adjacency.get(nodeId)?.length ?? 0) > 0;
};

const getLocationEntranceNodeIds = (
  graph: CampusRoutingGraph | null | undefined,
  locationId: string
): string[] => {
  if (!graph) {
    return [];
  }

  return (graph.entrancesByLocationId.get(locationId) ?? []).filter((nodeId) => graph.nodes.has(nodeId));
};

const getNearbyConnectedNodeIds = (
  graph: CampusRoutingGraph | null | undefined,
  feature: EditableFeature,
  maxDistanceMeters: number,
  limit = 3
): string[] => {
  if (!graph) {
    return [];
  }

  return Array.from(graph.nodes.values())
    .filter((node) => nodeHasGraphConnection(graph, node.id))
    .map((node) => ({
      id: node.id,
      distanceMeters: featureDistanceToPointMeters(feature, [node.coordinates[1], node.coordinates[0]]),
    }))
    .filter((entry) => Number.isFinite(entry.distanceMeters) && entry.distanceMeters <= maxDistanceMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters)
    .slice(0, limit)
    .map((entry) => entry.id);
};

const resolveRoutingNodeIdFromFeature = (feature: EditableFeature): string => {
  const properties = isRecord(feature.properties) ? feature.properties : {};
  return readFirstTrimmedProperty(properties, ['node_id', 'nodeId', 'id']) || toFeatureId(feature);
};

const buildRoutingNodeFeatureMap = (
  features: EditableFeature[]
): Map<string, EditableFeature> => {
  const entries = new Map<string, EditableFeature>();

  features.forEach((feature) => {
    if (feature.geometry.type !== 'Point') {
      return;
    }

    const nodeId = resolveRoutingNodeIdFromFeature(feature);
    if (nodeId && !entries.has(nodeId)) {
      entries.set(nodeId, feature);
    }
  });

  return entries;
};

const sortFeaturesByTitle = (left: EditableFeature, right: EditableFeature): number => {
  const titleComparison = featureTitle(left).localeCompare(featureTitle(right));
  if (titleComparison !== 0) {
    return titleComparison;
  }

  return toFeatureId(left).localeCompare(toFeatureId(right));
};

const normalizeMixedFeatureCollectionUpload = (
  input: unknown
): MapDatasetBundleInput<MapFeatureCollection> => {
  const collection = normalizeFeatureCollection(input);
  const locationFeatures = collection.features.filter((feature) => hasLocationGeometry(feature));
  const routingFeatures = collection.features.filter((feature) => hasRoutingGeometry(feature));

  if (locationFeatures.length === 0 || routingFeatures.length === 0) {
    throw new Error('Mixed FeatureCollection must include both location and routing features.');
  }

  const normalizedLocationFeatures: EditableFeature[] = locationFeatures.map((feature) => {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    const derivedType = deriveImportedLocationType(properties);
    const derivedName = deriveImportedLocationName(properties, derivedType);

    return {
      ...feature,
      properties: {
        ...properties,
        name: readTrimmedString(properties.name) || derivedName,
        type: derivedType,
      },
    };
  });

  const locationOptions = buildLocationAssociationOptions(normalizedLocationFeatures);

  const normalizedRoutingFeatures = routingFeatures.map((feature) => {
    if (feature.geometry.type !== 'Point') {
      return feature;
    }

    const properties = isRecord(feature.properties) ? feature.properties : {};
    const existingLocationId = readRoutingLocationAssociationId(properties);

    if (existingLocationId) {
      return feature;
    }

    const point = toMapLngLat(feature.geometry.coordinates);
    if (!point) {
      return feature;
    }

    const resolvedLocation = resolveLocationAssociationForPoint(point, locationOptions);
    if (!resolvedLocation) {
      return feature;
    }

    return {
        ...feature,
        properties: {
          ...properties,
          location_id: resolvedLocation.option.featureId,
        },
      };
  });

  return {
    type: 'wia-dataset-bundle',
    version: 1,
    locations: {
      type: 'FeatureCollection',
      features: normalizedLocationFeatures,
    },
    routing: {
      type: 'FeatureCollection',
      features: normalizedRoutingFeatures,
    },
  };
};

const readAccessPointRole = (feature: EditableFeature | null): AccessPointRole => {
  const properties = isRecord(feature?.properties) ? feature.properties : {};
  const role = readTrimmedString(properties.access_role).toLowerCase();
  if (role === 'exit' || role === 'both') {
    return role;
  }
  return 'entrance';
};

const isRoutingAccessPointLike = (feature: EditableFeature): boolean => {
  if (feature.geometry.type !== 'Point') {
    return false;
  }

  const properties = isRecord(feature.properties) ? feature.properties : {};
  const kind = readTrimmedString(properties.kind).toLowerCase();
  if (kind === 'entrance') {
    return true;
  }

  if (readTrimmedString(properties.access_role)) {
    return true;
  }

  const title = featureTitle(feature);
  return ACCESS_POINT_NAME_PATTERN.test(title);
};

const lineStringCoordinates = (feature: EditableFeature | null): [number, number][] => {
  if (!feature || feature.geometry.type !== 'LineString') {
    return [];
  }

  return feature.geometry.coordinates
    .map((coordinate) => toMapLngLat(coordinate))
    .filter((coordinate): coordinate is [number, number] => Boolean(coordinate));
};

const createLocationAccessPointFeature = (
  locationFeature: EditableFeature,
  role: AccessPointRole
): EditableFeature => {
  const locationId = toFeatureId(locationFeature);
  const seedCoordinate =
    featureCentroid(locationFeature) ??
    getFeaturePoint(locationFeature) ??
    [clientConfig.map.center[1], clientConfig.map.center[0]];
  const roleLabel = role === 'exit' ? 'Exit' : role === 'both' ? 'Entrance / Exit' : 'Entrance';

  return {
    type: 'Feature',
    id: `routing_access_${Date.now()}`,
    geometry: {
      type: 'Point',
      coordinates: [seedCoordinate[0], seedCoordinate[1]],
    },
    properties: {
      name: `${featureTitle(locationFeature)} ${roleLabel}`,
      kind: 'entrance',
      location_id: locationId,
      access_role: role,
      accessible: true,
      stairs: false,
      ramp: false,
      elevator: false,
    },
  };
};

const createAccessPointConnectorFeature = (
  locationFeature: EditableFeature,
  accessPointFeature: EditableFeature
): EditableFeature => {
  const accessPointId = toFeatureId(accessPointFeature);
  const locationId = toFeatureId(locationFeature);
  const anchor = getFeaturePoint(accessPointFeature) ?? featureCentroid(locationFeature) ?? [clientConfig.map.center[1], clientConfig.map.center[0]];

  return {
    type: 'Feature',
    id: `routing_connector_${Date.now()}`,
    geometry: {
      type: 'LineString',
      coordinates: [[anchor[0], anchor[1]]],
    },
    properties: {
      name: `${featureTitle(accessPointFeature)} connector`,
      kind: 'edge',
      highway: 'footway',
      location_id: locationId,
      access_point_id: accessPointId,
      accessible: true,
      stairs: false,
      ramp: false,
      elevator: false,
    },
  };
};

const pinConnectorGeometryToStart = (
  feature: EditableFeature,
  startPoint: [number, number]
): EditableFeature => {
  if (feature.geometry.type !== 'LineString') {
    return feature;
  }

  const coordinates = lineStringCoordinates(feature);
  const nextCoordinates = coordinates.length > 0
    ? [[startPoint[0], startPoint[1]], ...coordinates.slice(1)]
    : [[startPoint[0], startPoint[1]]];

  return {
    ...feature,
    geometry: {
      type: 'LineString',
      coordinates: nextCoordinates.map(([lng, lat]) => [lng, lat]),
    },
  };
};

const readStringProperty = (feature: EditableFeature | null, key: string): string => {
  const value = feature?.properties?.[key];
  return typeof value === 'string' ? value : '';
};

const readNumberProperty = (feature: EditableFeature | null, key: string): string => {
  const value = feature?.properties?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
};

const readBooleanProperty = (feature: EditableFeature | null, key: string): boolean => {
  return feature?.properties?.[key] === true;
};

const readStringArrayProperty = (feature: EditableFeature | null, key: string): string => {
  const value = feature?.properties?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').join(', ') : '';
};

const readStringArrayValues = (feature: EditableFeature | null, key: string): string[] => {
  const value = feature?.properties?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

const mutationErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Request failed';
};

const revisionTone = (changeType: string): 'default' | 'info' | 'success' | 'danger' | 'warning' => {
  const normalized = changeType.toLowerCase();
  if (normalized.includes('delete')) {
    return 'danger';
  }
  if (normalized.includes('restore')) {
    return 'warning';
  }
  if (normalized.includes('create')) {
    return 'success';
  }
  if (normalized.includes('upload') || normalized.includes('bulk') || normalized.includes('upsert')) {
    return 'info';
  }
  return 'default';
};

const geometrySummary = (feature: EditableFeature | null): string => {
  if (!feature) {
    return 'No geometry';
  }
  if (feature.geometry.type === 'Point') {
    return 'Single point';
  }
  if (feature.geometry.type === 'LineString') {
    const count = Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates.length : 0;
    return `${count} path point${count === 1 ? '' : 's'}`;
  }
  if (feature.geometry.type === 'Polygon') {
    const outerRing =
      Array.isArray(feature.geometry.coordinates) && Array.isArray(feature.geometry.coordinates[0])
        ? feature.geometry.coordinates[0]
        : [];
    return `${outerRing.length} polygon point${outerRing.length === 1 ? '' : 's'}`;
  }
  return feature.geometry.type;
};

const accessPointRoleLabel = (role: AccessPointRole): string => {
  return ACCESS_ROLE_OPTIONS.find((option) => option.value === role)?.label ?? 'Entrance';
};

const accessPointStatusTone = (
  record: Pick<LocationAccessPointRecord, 'connected' | 'missingLocationLink'>
): 'success' | 'warning' | 'danger' => {
  if (record.missingLocationLink) {
    return 'warning';
  }
  return record.connected ? 'success' : 'danger';
};

const accessPointStatusLabel = (
  record: Pick<LocationAccessPointRecord, 'connected' | 'missingLocationLink'>
): string => {
  if (record.missingLocationLink) {
    return 'Missing location link';
  }
  return record.connected ? 'Connected' : 'Disconnected';
};

function InputField({ label, value, onChange, type = 'text', fullWidth = false }: { label: string; value: string; onChange: (nextValue: string) => void; type?: 'text' | 'number'; fullWidth?: boolean; }): JSX.Element {
  return (
    <label className={cx('block', fullWidth ? 'md:col-span-2' : '')}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
      />
    </label>
  );
}

function PresetTextField({
  label,
  value,
  options,
  onChange,
  fullWidth = false,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (nextValue: string) => void;
  fullWidth?: boolean;
}): JSX.Element {
  const usesPreset = value === '' || options.some((option) => option.value === value);
  const selectValue = usesPreset ? value : '__other__';

  return (
    <div className={cx('block', fullWidth ? 'md:col-span-2' : '')}>
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span>
        <select
          value={selectValue}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue === '__other__' ? value : nextValue);
          }}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
        >
          <option value="">Unset</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value="__other__">Other...</option>
        </select>
      </label>
      {selectValue === '__other__' ? (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`Enter custom ${label.toLowerCase()}`}
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
        />
      ) : null}
    </div>
  );
}

function PresetListField({
  label,
  value,
  options,
  onChange,
  fullWidth = false,
}: {
  label: string;
  value: string[];
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (nextValue: string[]) => void;
  fullWidth?: boolean;
}): JSX.Element {
  const [customValue, setCustomValue] = useState('');
  const normalizedValue = value.filter(Boolean);
  const availableOptions = options.filter((option) => !normalizedValue.includes(option.value));

  const addValue = (nextValue: string): void => {
    const normalized = nextValue.trim();
    if (!normalized || normalizedValue.includes(normalized)) {
      return;
    }
    onChange([...normalizedValue, normalized]);
  };

  const removeValue = (entry: string): void => {
    onChange(normalizedValue.filter((item) => item !== entry));
  };

  return (
    <div className={cx('block', fullWidth ? 'md:col-span-2' : '')}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span>
      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <select
          value=""
          onChange={(event) => addValue(event.target.value)}
          className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
        >
          <option value="">Add preset...</option>
          {availableOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <input
            type="text"
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            placeholder="Other feature"
            className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
          />
          <button
            type="button"
            onClick={() => {
              addValue(customValue);
              setCustomValue('');
            }}
            className="rounded-2xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
          >
            Add
          </button>
        </div>
      </div>
      {normalizedValue.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {normalizedValue.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => removeValue(entry)}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
            >
              {entry} x
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  fullWidth = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (nextValue: string) => void;
  fullWidth?: boolean;
}): JSX.Element {
  return (
    <label className={cx('block', fullWidth ? 'md:col-span-2' : '')}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (nextValue: boolean) => void; }): JSX.Element {
  return (
    <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function StepPill({ index, label, active, complete }: { index: number; label: string; active: boolean; complete: boolean; }): JSX.Element {
  return (
    <div
      className={cx(
        'min-w-[140px] rounded-2xl border px-4 py-3 transition',
        active ? 'border-sky-200 bg-sky-50 text-sky-900' : complete ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-white text-slate-500'
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em]">Step {index + 1}</p>
      <p className="mt-2 text-sm font-semibold">{label}</p>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string; }): JSX.Element {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-950">{value || '-'}</p>
    </div>
  );
}

function WizardFooter({ stepLabel, onBack, onDiscard, onNext, onPublish, nextDisabled, publishDisabled, nextLabel, publishLabel, onDelete, onRawJson, deleteDisabled = false, selectedCount = 0 }: { stepLabel: string; onBack: () => void; onDiscard: () => void; onNext: () => void; onPublish: () => void; nextDisabled: boolean; publishDisabled: boolean; nextLabel: string; publishLabel: string; onDelete?: () => void; onRawJson?: () => void; deleteDisabled?: boolean; selectedCount?: number; }): JSX.Element {
  return (
    <div className="sticky bottom-4 z-20 pt-4">
      <div className="rounded-[28px] border border-slate-200 bg-white/95 px-4 py-4 shadow-[0_18px_48px_rgba(15,23,42,0.12)] backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{stepLabel}</p>
          <div className="flex flex-wrap items-center gap-2">
            {selectedCount > 0 && (onDelete || onRawJson) ? (
              <>
                {onDelete && (
                  <button type="button" onClick={onDelete} disabled={deleteDisabled} className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60">
                    Delete selected
                  </button>
                )}
                {onRawJson && (
                  <button type="button" onClick={onRawJson} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-300 hover:bg-slate-50">
                    Raw JSON
                  </button>
                )}
              </>
            ) : null}
            <button type="button" onClick={onBack} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950">Back</button>
            <button type="button" onClick={onDiscard} className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100">Discard</button>
            {nextLabel ? (
              <button type="button" onClick={onNext} disabled={nextDisabled} className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">{nextLabel}</button>
            ) : (
              <button type="button" onClick={onPublish} disabled={publishDisabled} className="rounded-full bg-sky-600 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60">{publishLabel}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UtilityFooter({ stepLabel, onBackToFlow }: { stepLabel: string; onBackToFlow: () => void; }): JSX.Element {
  return (
    <div className="sticky bottom-4 z-20 pt-4">
      <div className="rounded-[28px] border border-slate-200 bg-white/95 px-4 py-4 shadow-[0_18px_48px_rgba(15,23,42,0.12)] backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{stepLabel}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onBackToFlow} className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800">
              Back to flow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoutingValidationNotice({
  preview,
  title,
}: {
  preview: RoutingValidationPreview;
  title: string;
}): JSX.Element {
  const hasIssues = preview.errors.length > 0 || preview.warnings.length > 0;

  return (
    <div
      className={cx(
        'rounded-[26px] border px-4 py-4',
        preview.isEmptyGraph
          ? 'border-sky-200 bg-sky-50/70'
          : hasIssues
            ? 'border-amber-200 bg-amber-50/70'
            : 'border-emerald-200 bg-emerald-50/70'
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AdminStatusBadge tone={preview.isEmptyGraph ? 'info' : preview.errors.length > 0 ? 'danger' : hasIssues ? 'warning' : 'success'}>
          {preview.isEmptyGraph
            ? 'Routing dataset is empty'
            : preview.errors.length > 0
              ? 'Routing issues detected'
              : hasIssues
                ? 'Routing warnings detected'
                : 'Routing looks connected'}
        </AdminStatusBadge>
        {preview.autoConnectedWarnings.length > 0 ? (
          <AdminStatusBadge tone="info">
            {preview.autoConnectedWarnings.length} auto-connected entrance{preview.autoConnectedWarnings.length === 1 ? '' : 's'}
          </AdminStatusBadge>
        ) : null}
        {preview.unreachableWarnings.length > 0 ? (
          <AdminStatusBadge tone="warning">
            {preview.unreachableWarnings.length} entrance{preview.unreachableWarnings.length === 1 ? '' : 's'} still too far
          </AdminStatusBadge>
        ) : null}
        {preview.errors.length > 0 ? (
          <AdminStatusBadge tone="danger">
            {preview.errors.length} validation error{preview.errors.length === 1 ? '' : 's'}
          </AdminStatusBadge>
        ) : null}
      </div>
      <h4 className="mt-3 font-['Outfit'] text-xl font-semibold text-slate-950">{title}</h4>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {preview.isEmptyGraph
          ? 'No live walkway graph will be published from this upload. Users will fall back to direct routing until routing features are added again.'
          : 'Entrances that do not land exactly on a walkway vertex are auto-connected when they fall within 24m of a nearby walkway segment.'}
      </p>
      {preview.isEmptyGraph ? (
        <p className="mt-3 text-sm font-medium text-sky-800">This upload currently publishes an empty routing dataset.</p>
      ) : !hasIssues ? (
        <p className="mt-3 text-sm font-medium text-emerald-800">No routing connectivity warnings were detected in this upload.</p>
      ) : null}
      {preview.errors.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-white px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700">Blocking validation errors</p>
          <div className="mt-3 space-y-2">
            {preview.errors.slice(0, 4).map((error) => (
              <p key={error} className="text-sm leading-6 text-rose-800">{error}</p>
            ))}
          </div>
        </div>
      ) : null}
      {preview.autoConnectedWarnings.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-sky-200 bg-white px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700">Auto-connected entrances</p>
          <div className="mt-3 space-y-2">
            {preview.autoConnectedWarnings.slice(0, 4).map((warning) => (
              <p key={warning} className="text-sm leading-6 text-slate-700">{warning}</p>
            ))}
          </div>
        </div>
      ) : null}
      {preview.unreachableWarnings.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-white px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Still unreachable</p>
          <div className="mt-3 space-y-2">
            {preview.unreachableWarnings.slice(0, 4).map((warning) => (
              <p key={warning} className="text-sm leading-6 text-slate-700">{warning}</p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function AdminDatasetManagerPage({
  enabled,
  onLocationsChanged,
  pendingFocusRequest = null,
  onConsumeFocusRequest,
}: AdminDatasetManagerPageProps): JSX.Element {
  const { showError, showSuccess, showWarning } = useToast();
  const [datasetType, setDatasetType] = useState<MapDatasetType>('locations');
  const [dataset, setDataset] = useState<MapDatasetRecord<MapFeatureCollection> | null>(null);
  const [referenceDataset, setReferenceDataset] = useState<MapDatasetRecord<MapFeatureCollection> | null>(null);
  const [revisions, setRevisions] = useState<MapDatasetRevisionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<DatasetView>('landing');
  const [intent, setIntent] = useState<DatasetIntent | null>(null);
  const [wizardStep, setWizardStep] = useState<WizardStep>(0);
  const [utilityView, setUtilityView] = useState<UtilityView>('import');
  const [wizardReturnUtilityView, setWizardReturnUtilityView] = useState<UtilityView | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [locationPickerQuery, setLocationPickerQuery] = useState('');
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<string[]>([]);
  const [editingSourceFeatureId, setEditingSourceFeatureId] = useState<string | null>(null);
  const [draftFeature, setDraftFeature] = useState<EditableFeature | null>(null);
  const [draftSnapshot, setDraftSnapshot] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftTextError, setDraftTextError] = useState<string | null>(null);
  const [locationImportSetup, setLocationImportSetup] = useState<LocationImportSetupState | null>(null);
  const [routingImportSetup, setRoutingImportSetup] = useState<RoutingImportSetupState | null>(null);
  const [bundleImportSetup, setBundleImportSetup] = useState<BundleImportSetupState | null>(null);
  const [pendingTransition, setPendingTransition] = useState<PendingTransitionState | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingActionState | null>(null);
  const [accessPointDraft, setAccessPointDraft] = useState<EditableFeature | null>(null);
  const [accessPointDraftSourceId, setAccessPointDraftSourceId] = useState<string | null>(null);
  const [connectorDraft, setConnectorDraft] = useState<EditableFeature | null>(null);
  const [connectorDraftSourceId, setConnectorDraftSourceId] = useState<string | null>(null);
  const [linkedRoutingSaving, setLinkedRoutingSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const editingSourceFeatureIdRef = useRef<string | null>(null);

  useEffect(() => {
    editingSourceFeatureIdRef.current = editingSourceFeatureId;
  }, [editingSourceFeatureId]);

  useEffect(() => {
    setLocationPickerQuery('');
  }, [datasetType, editingSourceFeatureId, draftFeature?.id]);

  const clearLocationImportSetup = useCallback((): void => {
    setLocationImportSetup(null);
  }, []);

  const clearRoutingImportSetup = useCallback((): void => {
    setRoutingImportSetup(null);
  }, []);

  const clearBundleImportSetup = useCallback((): void => {
    setBundleImportSetup(null);
  }, []);

  const clearDraft = useCallback((): void => {
    setEditingSourceFeatureId(null);
    setDraftFeature(null);
    setDraftSnapshot(null);
    setDraftText('');
    setDraftTextError(null);
  }, []);

  const clearAccessPointDraft = useCallback((): void => {
    setAccessPointDraft(null);
    setAccessPointDraftSourceId(null);
  }, []);

  const clearConnectorDraft = useCallback((): void => {
    setConnectorDraft(null);
    setConnectorDraftSourceId(null);
  }, []);

  const loadDraft = useCallback((feature: EditableFeature, sourceId = toFeatureId(feature), snapshot: string | null = stringifyFeature(feature)): void => {
    setEditingSourceFeatureId(sourceId || null);
    setDraftFeature(feature);
    setDraftSnapshot(snapshot);
    setDraftText(stringifyFeature(feature));
    setDraftTextError(null);
  }, []);

  const writeDraftFeature = useCallback((feature: EditableFeature): void => {
    setDraftFeature(feature);
    setDraftText(stringifyFeature(feature));
    setDraftTextError(null);
  }, []);

  useEffect(() => {
    clearAccessPointDraft();
    clearConnectorDraft();
  }, [clearAccessPointDraft, clearConnectorDraft, datasetType, editingSourceFeatureId]);

  const referenceDatasetType: MapDatasetType = datasetType === 'locations' ? 'routing' : 'locations';

  const hydrateWorkspace = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }

    setLoading(true);
    try {
      const [nextDataset, nextRevisions, nextReferenceDataset] = await Promise.all([
        fetchAdminMapDataset<MapFeatureCollection>(datasetType),
        fetchAdminMapDatasetRevisions(datasetType, 20),
        fetchAdminMapDataset<MapFeatureCollection>(referenceDatasetType).catch(() => null),
      ]);
      setDataset(nextDataset);
      setReferenceDataset(nextReferenceDataset);
      setRevisions(nextRevisions);

      if (editingSourceFeatureIdRef.current) {
        const matchedFeature = nextDataset.collection.features.find(
          (feature) => toFeatureId(feature as EditableFeature) === editingSourceFeatureIdRef.current
        ) as EditableFeature | undefined;

        if (matchedFeature) {
          loadDraft(normalizeEditableFeature(matchedFeature), toFeatureId(matchedFeature));
        } else {
          clearDraft();
        }
      }
    } catch (error) {
      showError(mutationErrorMessage(error), {
        title: 'Dataset manager',
        dedupeKey: `dataset-load-${datasetType}`,
      });
    } finally {
      setLoading(false);
    }
  }, [clearDraft, datasetType, enabled, loadDraft, referenceDatasetType, showError]);

  useEffect(() => {
    void hydrateWorkspace();
  }, [hydrateWorkspace]);

  const features = useMemo(() => {
    return (dataset?.collection.features ?? []).map((feature) => normalizeEditableFeature(feature));
  }, [dataset]);

  const referenceFeatures = useMemo(() => {
    return (referenceDataset?.collection.features ?? []).map((feature) => normalizeEditableFeature(feature));
  }, [referenceDataset]);

  const liveLocationsCollection = useMemo(() => {
    return datasetType === 'locations'
      ? dataset?.collection ?? null
      : referenceDataset?.collection ?? null;
  }, [dataset?.collection, datasetType, referenceDataset?.collection]);

  const liveRoutingCollection = useMemo(() => {
    return datasetType === 'routing'
      ? dataset?.collection ?? null
      : referenceDataset?.collection ?? null;
  }, [dataset?.collection, datasetType, referenceDataset?.collection]);

  const liveLocationFeatures = useMemo(() => {
    return datasetType === 'locations' ? features : referenceFeatures;
  }, [datasetType, features, referenceFeatures]);

  const liveRoutingFeatures = useMemo(() => {
    return datasetType === 'routing' ? features : referenceFeatures;
  }, [datasetType, features, referenceFeatures]);

  const liveRoutingValidation = useMemo(() => {
    return liveRoutingCollection
      ? validateRoutingGraph(liveRoutingCollection, {
          strict: false,
          allowEmptyGraph: true,
          locations: liveLocationsCollection ?? null,
        })
      : null;
  }, [liveLocationsCollection, liveRoutingCollection]);

  const getRoutingDeletePreview = useCallback((featureIds: string[]): RoutingDeletePreview | null => {
    const normalizedIds = [...new Set(
      featureIds
        .map((featureId) => (typeof featureId === 'string' ? featureId.trim() : ''))
        .filter(Boolean)
    )];

    if (!liveRoutingCollection || normalizedIds.length === 0) {
      return null;
    }

    const nextCollection: MapFeatureCollection = {
      ...liveRoutingCollection,
      features: liveRoutingCollection.features.filter(
        (feature) => !normalizedIds.includes(toFeatureId(feature as EditableFeature))
      ),
    };
    const deletedCount = liveRoutingCollection.features.length - nextCollection.features.length;
    const validation = validateRoutingGraph(nextCollection, {
      strict: true,
      allowEmptyGraph: true,
      locations: liveLocationsCollection ?? null,
    });

    return {
      deletedCount,
      validationErrors: validation.errors,
      isEmptyGraph:
        validation.errors.length === 0 &&
        validation.warnings.length === 0 &&
        isEmptyRoutingGraph(validation.graph),
    };
  }, [liveLocationsCollection, liveRoutingCollection]);

  const mapReferenceFeatures = useMemo(() => {
    return [...features, ...referenceFeatures];
  }, [features, referenceFeatures]);

  const filteredFeatures = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return features;
    }
    return features.filter((feature) => featureSearchText(feature).includes(normalizedQuery));
  }, [features, searchQuery]);

  useEffect(() => {
    if (!pendingFocusRequest) {
      return;
    }

    if (datasetType !== pendingFocusRequest.datasetType) {
      setDatasetType(pendingFocusRequest.datasetType);
      return;
    }

    if (loading) {
      return;
    }

    const targetFeature = features.find((feature) => toFeatureId(feature) === pendingFocusRequest.featureId);
    if (!targetFeature) {
      if (dataset) {
        showWarning(`Could not find feature "${pendingFocusRequest.featureId}" in the ${formatDatasetLabel(datasetType).toLowerCase()}.`, {
          title: 'Dataset focus',
          dedupeKey: `dataset-focus-missing-${pendingFocusRequest.featureId}`,
        });
        onConsumeFocusRequest?.();
      }
      return;
    }

    clearLocationImportSetup();
    clearRoutingImportSetup();
    clearBundleImportSetup();
    clearAccessPointDraft();
    clearConnectorDraft();
    setSearchQuery('');
    setSelectedFeatureIds([]);
    setIntent('edit-existing');
    setWizardStep(1);
    setViewMode('wizard');
    loadDraft(targetFeature, toFeatureId(targetFeature));
    onConsumeFocusRequest?.();

    if (pendingFocusRequest.revealSection === 'access-points' && typeof window !== 'undefined') {
      window.setTimeout(() => {
        document.getElementById('dataset-access-points-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    }
  }, [
    clearAccessPointDraft,
    clearBundleImportSetup,
    clearConnectorDraft,
    clearLocationImportSetup,
    clearRoutingImportSetup,
    dataset,
    datasetType,
    features,
    loadDraft,
    loading,
    onConsumeFocusRequest,
    pendingFocusRequest,
    showWarning,
  ]);

  const geometryOptions = geometryOptionsByDataset[datasetType];
  const currentSteps = intent ? wizardStepsByIntent[intent] : [];
  const filteredFeatureIds = useMemo(() => filteredFeatures.map((feature) => toFeatureId(feature)).filter(Boolean), [filteredFeatures]);
  const activeFeatureId = editingSourceFeatureId || toFeatureId(draftFeature);
  const liveFeatureCount = dataset?.collection.features.length ?? 0;
  const selectedCount = selectedFeatureIds.length;
  const selectedInViewCount = filteredFeatureIds.filter((featureId) => selectedFeatureIds.includes(featureId)).length;
  const allFilteredSelected = filteredFeatureIds.length > 0 && selectedInViewCount === filteredFeatureIds.length;
  const partiallyFilteredSelected = selectedInViewCount > 0 && !allFilteredSelected;
  const isLocationsDataset = datasetType === 'locations';
  const isExistingFeature = Boolean(editingSourceFeatureId);
  const draftSerialized = stringifyFeature(draftFeature);
  const isDirty = Boolean(draftFeature && (draftSnapshot === null || draftSerialized !== draftSnapshot || draftText !== draftSerialized));
  const canProceed = intent ? (wizardStep === 0 ? (intent === 'edit-existing' ? Boolean(editingSourceFeatureId && draftFeature) : Boolean(draftFeature)) : Boolean(draftFeature)) : false;
  const canPublish = Boolean(draftFeature && !draftTextError && isDirty && wizardStep === 3);
  const publishLabel = saving ? 'Publishing...' : isExistingFeature ? 'Publish changes' : 'Publish feature';
  const activeUtilityLabel = utilityTabs.find((tab) => tab.id === utilityView)?.label ?? 'Utilities';
  const locationAssociationOptions = useMemo(() => {
    return buildLocationAssociationOptions(referenceFeatures);
  }, [referenceFeatures]);
  const isRoutingPointFeature = !isLocationsDataset && isPointGeometry(draftFeature);
  const routingAssociationId = useMemo(() => {
    if (!draftFeature || !isRecord(draftFeature.properties)) {
      return '';
    }
    return readRoutingLocationAssociationId(draftFeature.properties);
  }, [draftFeature]);
  const resolvedRoutingAssociation = useMemo(() => {
    if (!routingAssociationId) {
      return null;
    }
    return (
      locationAssociationOptions.find((option) => option.featureId === routingAssociationId) ?? null
    );
  }, [locationAssociationOptions, routingAssociationId]);
  const draftRoutingPoint = useMemo(() => {
    return isRoutingPointFeature ? getFeaturePoint(draftFeature) : null;
  }, [draftFeature, isRoutingPointFeature]);
  const containingLocationSuggestion = useMemo(() => {
    if (!draftRoutingPoint) {
      return null;
    }
    return resolveContainingLocationAssociation(draftRoutingPoint, locationAssociationOptions);
  }, [draftRoutingPoint, locationAssociationOptions]);
  const nearestLocationSuggestion = useMemo(() => {
    if (!draftRoutingPoint) {
      return null;
    }
    return resolveNearestLocationAssociation(draftRoutingPoint, locationAssociationOptions);
  }, [draftRoutingPoint, locationAssociationOptions]);
  const filteredLocationAssociationOptions = useMemo(() => {
    const normalizedQuery = locationPickerQuery.trim().toLowerCase();
    const baseOptions = normalizedQuery
      ? locationAssociationOptions.filter((option) => option.searchText.includes(normalizedQuery))
      : locationAssociationOptions;

    if (!resolvedRoutingAssociation) {
      return baseOptions.slice(0, 10);
    }

    const prioritizedOptions = [
      resolvedRoutingAssociation,
      ...baseOptions.filter((option) => option.featureId !== resolvedRoutingAssociation.featureId),
    ];
    return prioritizedOptions.slice(0, 10);
  }, [locationAssociationOptions, locationPickerQuery, resolvedRoutingAssociation]);
  const routingTextFieldsForDraft = useMemo(() => {
    if (!isRoutingPointFeature) {
      return routingTextFields;
    }
    return routingTextFields.filter((field) => field.key !== 'location_id');
  }, [isRoutingPointFeature]);
  const liveLocationFeatureId = isExistingFeature ? editingSourceFeatureId ?? '' : toFeatureId(draftFeature);
  const accessPointsLockedReason = !isLocationsDataset
    ? ''
    : !draftFeature
      ? 'Open a location feature first.'
      : !isExistingFeature
        ? 'Publish this building first before adding entrances or exits.'
        : editingSourceFeatureId !== toFeatureId(draftFeature)
          ? 'Publish the location id change before editing linked access points.'
          : '';
  const canManageAccessPoints = isLocationsDataset && !accessPointsLockedReason && Boolean(liveLocationFeatureId);
  const draftAwareLocationReferenceFeatures = useMemo(() => {
    if (datasetType !== 'locations' || !draftFeature) {
      return liveLocationFeatures;
    }

    const draftId = editingSourceFeatureId ?? toFeatureId(draftFeature);
    return [
      draftFeature,
      ...liveLocationFeatures.filter((feature) => toFeatureId(feature) !== draftId),
    ];
  }, [datasetType, draftFeature, editingSourceFeatureId, liveLocationFeatures]);
  const locationAccessEditorReferenceFeatures = useMemo(() => {
    return [...draftAwareLocationReferenceFeatures, ...liveRoutingFeatures];
  }, [draftAwareLocationReferenceFeatures, liveRoutingFeatures]);
  const locationAccessPoints = useMemo<LocationAccessPointRecord[]>(() => {
    if (!draftFeature || !liveLocationFeatureId) {
      return [];
    }

    const locationCentroid = featureCentroid(draftFeature);
    const connectorCounts = new Map<string, number>();
    liveRoutingFeatures.forEach((feature) => {
      if (feature.geometry.type !== 'LineString') {
        return;
      }

      const properties = isRecord(feature.properties) ? feature.properties : {};
      const accessPointId = readTrimmedString(properties.access_point_id);
      if (!accessPointId) {
        return;
      }

      connectorCounts.set(accessPointId, (connectorCounts.get(accessPointId) ?? 0) + 1);
    });

    const pointWithinLocationContext = (point: [number, number]): boolean => {
      if (isPolygonLocationFeature(draftFeature)) {
        return featureContainsPoint(draftFeature, point);
      }

      if (!locationCentroid) {
        return false;
      }

      return haversineDistanceMeters(locationCentroid, point) <= 20;
    };

    return liveRoutingFeatures
      .map((feature) => {
        if (feature.geometry.type !== 'Point') {
          return null;
        }

        const properties = isRecord(feature.properties) ? feature.properties : {};
        const linkedLocationId = readRoutingLocationAssociationId(properties);
        const featurePoint = getFeaturePoint(feature);
        const matchesLinkedLocation = linkedLocationId === liveLocationFeatureId;
        const matchesLegacyLocation = !linkedLocationId && featurePoint && isRoutingAccessPointLike(feature) && pointWithinLocationContext(featurePoint);

        if (!matchesLinkedLocation && !matchesLegacyLocation) {
          return null;
        }

        const featureId = toFeatureId(feature);
        const nodeId = resolveRoutingNodeIdFromFeature(feature);

        return {
          feature,
          featureId,
          nodeId,
          locationId: linkedLocationId || liveLocationFeatureId,
          role: readAccessPointRole(feature),
          connected: nodeHasGraphConnection(liveRoutingValidation?.graph, nodeId),
          missingLocationLink: !linkedLocationId,
          title: featureTitle(feature),
          connectorCount: connectorCounts.get(featureId) ?? 0,
        } satisfies LocationAccessPointRecord;
      })
      .filter((entry): entry is LocationAccessPointRecord => Boolean(entry))
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [draftFeature, liveLocationFeatureId, liveRoutingFeatures, liveRoutingValidation]);
  const selectedAccessPointRecord = useMemo(() => {
    if (!accessPointDraftSourceId) {
      return null;
    }

    return locationAccessPoints.find((entry) => entry.featureId === accessPointDraftSourceId) ?? null;
  }, [accessPointDraftSourceId, locationAccessPoints]);
  const activeAccessPointFeature = accessPointDraft ?? selectedAccessPointRecord?.feature ?? null;
  const activeAccessPointCoordinate = getFeaturePoint(activeAccessPointFeature);
  const selectedAccessPointConnectors = useMemo<AccessPointConnectorRecord[]>(() => {
    if (!accessPointDraftSourceId) {
      return [];
    }

    return liveRoutingFeatures
      .map((feature) => {
        if (feature.geometry.type !== 'LineString') {
          return null;
        }

        const properties = isRecord(feature.properties) ? feature.properties : {};
        if (readTrimmedString(properties.access_point_id) !== accessPointDraftSourceId) {
          return null;
        }

        return {
          feature,
          featureId: toFeatureId(feature),
          title: featureTitle(feature),
        } satisfies AccessPointConnectorRecord;
      })
      .filter((entry): entry is AccessPointConnectorRecord => Boolean(entry))
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [accessPointDraftSourceId, liveRoutingFeatures]);
  const selectedConnectorRecord = useMemo(() => {
    if (!connectorDraftSourceId) {
      return null;
    }

    return selectedAccessPointConnectors.find((entry) => entry.featureId === connectorDraftSourceId) ?? null;
  }, [connectorDraftSourceId, selectedAccessPointConnectors]);
  const accessPointDraftSerialized = stringifyFeature(accessPointDraft);
  const selectedAccessPointSerialized = stringifyFeature(selectedAccessPointRecord?.feature ?? null);
  const isAccessPointDraftDirty = Boolean(
    accessPointDraft && (accessPointDraftSourceId === null || accessPointDraftSerialized !== selectedAccessPointSerialized)
  );
  const canCreateConnector = Boolean(accessPointDraftSourceId && activeAccessPointCoordinate && !isAccessPointDraftDirty);
  const coverageReport = useMemo<CoverageReport | null>(() => {
    if (!liveLocationsCollection || !liveRoutingCollection || !liveRoutingValidation) {
      return null;
    }

    const polygonLocations = liveLocationFeatures
      .filter(
        (feature) =>
          isPolygonLocationFeature(feature) &&
          Boolean(toFeatureId(feature)) &&
          !isOpenAreaFeature(feature)
      )
      .sort(sortFeaturesByTitle);
    const isEmptyGraph =
      liveRoutingValidation.errors.length === 0 &&
      liveRoutingValidation.warnings.length === 0 &&
      isEmptyRoutingGraph(liveRoutingValidation.graph);

    if (isEmptyGraph) {
      return {
        polygonLocationCount: polygonLocations.length,
        noExplicitEntrance: [],
        inferredOnly: [],
        indoorAccessMissing: [],
        heuristicOnly: [],
        noRoutableAccess: [],
        unmappedEntranceIssues: [],
        unreachableEntranceIssues: [],
        graphErrors: [],
        graphWarnings: [],
        partialGraph: false,
        combinedRoutingIssueCount: 0,
        isEmptyGraph: true,
      };
    }

    const baseGraph = liveRoutingValidation.graph;
    const effectiveGraph = withInferredLocationEntrances(baseGraph, liveLocationsCollection);
    const locationFeatureById = new Map(
      liveLocationFeatures
        .map((feature) => {
          const featureId = toFeatureId(feature);
          return featureId ? [featureId, feature] : null;
        })
        .filter((entry): entry is [string, EditableFeature] => Boolean(entry))
    );
    const routingNodeFeatureByNodeId = buildRoutingNodeFeatureMap(liveRoutingFeatures);

    const buildLocationIssue = (feature: EditableFeature): CoverageLocationIssue => {
      const locationId = toFeatureId(feature);
      const explicitEntranceIds = getLocationEntranceNodeIds(baseGraph, locationId);
      const effectiveEntranceIds = getLocationEntranceNodeIds(effectiveGraph, locationId);
      const explicitConnectedEntranceIds = explicitEntranceIds.filter((nodeId) =>
        nodeHasGraphConnection(baseGraph, nodeId)
      );
      const effectiveConnectedEntranceIds = effectiveEntranceIds.filter((nodeId) =>
        nodeHasGraphConnection(effectiveGraph, nodeId)
      );
      const heuristicConnectedNodeIds =
        effectiveConnectedEntranceIds.length === 0
          ? getNearbyConnectedNodeIds(effectiveGraph, feature, 35)
          : [];
      const drillInNodeId =
        explicitEntranceIds[0] ??
        effectiveEntranceIds[0] ??
        heuristicConnectedNodeIds[0] ??
        null;

      return {
        feature,
        locationId,
        explicitEntranceIds,
        explicitConnectedEntranceIds,
        effectiveEntranceIds,
        effectiveConnectedEntranceIds,
        heuristicConnectedNodeIds,
        routingFeature: drillInNodeId ? routingNodeFeatureByNodeId.get(drillInNodeId) ?? null : null,
      };
    };

    const locationIssues = polygonLocations.map(buildLocationIssue);
    const noExplicitEntrance = locationIssues.filter((issue) => issue.explicitEntranceIds.length === 0);
    const inferredOnly = locationIssues.filter(
      (issue) =>
        issue.explicitEntranceIds.length === 0 &&
        issue.effectiveConnectedEntranceIds.length > 0
    );
    const indoorAccessMissing = locationIssues.filter(
      (issue) =>
        issue.explicitConnectedEntranceIds.length === 0 &&
        (issue.effectiveConnectedEntranceIds.length > 0 || issue.heuristicConnectedNodeIds.length > 0)
    );
    const heuristicOnly = locationIssues.filter(
      (issue) =>
        issue.effectiveConnectedEntranceIds.length === 0 &&
        issue.heuristicConnectedNodeIds.length > 0
    );
    const noRoutableAccess = locationIssues.filter(
      (issue) =>
        issue.effectiveConnectedEntranceIds.length === 0 &&
        issue.heuristicConnectedNodeIds.length === 0
    );

    const unmappedEntranceIssues = baseGraph
      ? Array.from(baseGraph.nodes.values())
          .filter((node) => node.kind === 'entrance' && !node.locationId)
          .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))
          .map((node) => ({
            key: `unmapped_${node.id}`,
            nodeId: node.id,
            title: node.name ?? node.id,
            description: `This entrance node has no location_id mapping, so the router cannot tie it to any location feature.`,
            routingFeature: routingNodeFeatureByNodeId.get(node.id) ?? null,
            locationFeature: null,
          }))
      : [];

    const unreachableEntranceIssues = baseGraph
      ? Array.from(baseGraph.nodes.values())
          .filter((node) => node.kind === 'entrance' && !nodeHasGraphConnection(baseGraph, node.id))
          .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))
          .map((node) => ({
            key: `unreachable_${node.id}`,
            nodeId: node.id,
            title: node.name ?? node.id,
            description: node.locationId && locationFeatureById.has(node.locationId)
              ? `This entrance node is not connected to a routable path for ${featureTitle(locationFeatureById.get(node.locationId) as EditableFeature)}.`
              : 'This entrance node is not connected to any routable path.',
            routingFeature: routingNodeFeatureByNodeId.get(node.id) ?? null,
            locationFeature: node.locationId ? locationFeatureById.get(node.locationId) ?? null : null,
          }))
      : [];

    const combinedRoutingIssueCount = new Set([
      ...unmappedEntranceIssues.map((issue) => issue.nodeId),
      ...unreachableEntranceIssues.map((issue) => issue.nodeId),
    ]).size;

    return {
      polygonLocationCount: polygonLocations.length,
      noExplicitEntrance,
      inferredOnly,
      indoorAccessMissing,
      heuristicOnly,
      noRoutableAccess,
      unmappedEntranceIssues,
      unreachableEntranceIssues,
      graphErrors: liveRoutingValidation.errors,
      graphWarnings: liveRoutingValidation.warnings,
      partialGraph: liveRoutingValidation.errors.length > 0,
      combinedRoutingIssueCount,
      isEmptyGraph: false,
    };
  }, [
    liveLocationFeatures,
    liveLocationsCollection,
    liveRoutingCollection,
    liveRoutingFeatures,
    liveRoutingValidation,
  ]);
  const locationImportPreview = useMemo(() => {
    if (!locationImportSetup) {
      return null;
    }

    return buildLocationImportPreview(
      locationImportSetup.collection,
      locationImportSetup.selectedSourceProperty
    );
  }, [locationImportSetup]);
  const bundleLocationImportPreview = useMemo(() => {
    if (!bundleImportSetup) {
      return null;
    }

    return buildLocationImportPreview(
      bundleImportSetup.bundle.locations,
      bundleImportSetup.selectedLocationSourceProperty
    );
  }, [bundleImportSetup]);
  const routingImportPreview = useMemo(() => {
    if (!routingImportSetup) {
      return null;
    }

    return buildRoutingValidationPreview(routingImportSetup.collection, liveLocationsCollection);
  }, [liveLocationsCollection, routingImportSetup]);
  const bundleRoutingImportPreview = useMemo(() => {
    if (!bundleImportSetup) {
      return null;
    }

    return buildRoutingValidationPreview(bundleImportSetup.bundle.routing, liveLocationsCollection);
  }, [bundleImportSetup, liveLocationsCollection]);

  useEffect(() => {
    if (!selectAllCheckboxRef.current) {
      return;
    }

    selectAllCheckboxRef.current.indeterminate = partiallyFilteredSelected;
  }, [partiallyFilteredSelected]);

  const applyTransition = useCallback((action: PendingTransitionState['action']): void => {
    if (action.kind === 'landing') {
      clearDraft();
      clearLocationImportSetup();
      clearRoutingImportSetup();
      clearBundleImportSetup();
      setWizardReturnUtilityView(null);
      setSearchQuery('');
      setSelectedFeatureIds([]);
      setIntent(null);
      setWizardStep(0);
      setViewMode('landing');
      return;
    }
    if (action.kind === 'intent') {
      clearDraft();
      clearLocationImportSetup();
      clearRoutingImportSetup();
      clearBundleImportSetup();
      setWizardReturnUtilityView(null);
      setSearchQuery('');
      setSelectedFeatureIds([]);
      setIntent(action.nextIntent);
      setWizardStep(0);
      setViewMode('wizard');
      return;
    }
    if (action.kind === 'dataset') {
      clearDraft();
      clearLocationImportSetup();
      clearRoutingImportSetup();
      clearBundleImportSetup();
      setWizardReturnUtilityView(null);
      setSearchQuery('');
      setSelectedFeatureIds([]);
      setWizardStep(0);
      setDatasetType(action.nextDatasetType);
      return;
    }
    if (action.kind === 'open-feature') {
      clearLocationImportSetup();
      clearRoutingImportSetup();
      clearBundleImportSetup();
      setWizardReturnUtilityView(viewMode === 'utilities' ? utilityView : null);
      setSearchQuery('');
      setSelectedFeatureIds([]);
      setIntent('edit-existing');
      setWizardStep(1);
      setViewMode('wizard');
      if (action.nextDatasetType !== datasetType) {
        setDatasetType(action.nextDatasetType);
      }
      loadDraft(action.feature, toFeatureId(action.feature));
      return;
    }
    setWizardReturnUtilityView(null);
    setUtilityView(action.nextUtilityView);
    setViewMode('utilities');
  }, [clearBundleImportSetup, clearDraft, clearLocationImportSetup, clearRoutingImportSetup, datasetType, loadDraft, utilityView, viewMode]);

  const guardTransition = useCallback((action: PendingTransitionState['action'], title: string, message: string, confirmLabel: string): void => {
    if (!isDirty) {
      applyTransition(action);
      return;
    }
    setPendingTransition({ open: true, title, message, confirmLabel, action });
  }, [applyTransition, isDirty]);

  const openCoverageFeature = useCallback((nextDatasetType: MapDatasetType, feature: EditableFeature | null | undefined): void => {
    if (!feature) {
      return;
    }

    guardTransition(
      { kind: 'open-feature', nextDatasetType, feature },
      'Open this feature?',
      'Opening this issue switches the editor to that live feature and discards unsaved changes in the current draft.',
      'Open feature'
    );
  }, [guardTransition]);

  const handleWizardBack = useCallback((): void => {
    if (wizardStep === 0) {
      guardTransition(
        { kind: 'landing' },
        'Leave this flow?',
        'Leaving the flow discards unsaved changes in the current draft.',
        'Leave flow'
      );
      return;
    }

    if (wizardStep === 1 && wizardReturnUtilityView) {
      setUtilityView(wizardReturnUtilityView);
      setViewMode('utilities');
      return;
    }

    setWizardStep((current) => Math.max(0, current - 1) as WizardStep);
  }, [guardTransition, wizardReturnUtilityView, wizardStep]);

  const toggleSelectedFeature = (featureId: string): void => {
    setSelectedFeatureIds((current) => current.includes(featureId) ? current.filter((item) => item !== featureId) : [...current, featureId]);
  };

  const toggleSelectAllFiltered = (): void => {
    if (filteredFeatureIds.length === 0) {
      return;
    }

    setSelectedFeatureIds((current) => {
      const nextSelected = new Set(current);
      if (allFilteredSelected) {
        filteredFeatureIds.forEach((featureId) => nextSelected.delete(featureId));
      } else {
        filteredFeatureIds.forEach((featureId) => nextSelected.add(featureId));
      }
      return Array.from(nextSelected);
    });
  };

  const applyMutationResult = async (result: MapDatasetMutationRecord<MapFeatureCollection>, successMessage: string, preferredFeatureId?: string | null): Promise<void> => {
    setDataset(result.dataset);
    setRevisions((current) => [result.revision, ...current.filter((revision) => revision.id !== result.revision.id)].slice(0, 20));
    setSelectedFeatureIds([]);
    clearLocationImportSetup();
    clearRoutingImportSetup();
    clearBundleImportSetup();

    await writeCachedMapDataset(result.dataset);
    publishMapDatasetUpdated(result.dataset);

    if (result.dataset.datasetType === 'locations') {
      await onLocationsChanged();
    }
    if (result.warnings.length > 0) {
      showWarning(result.warnings.join(' '), {
        title: 'Validation warning',
        dedupeKey: `dataset-warning-${result.revision.id}`,
      });
    }
    showSuccess(successMessage, {
      title: 'Dataset updated',
      dedupeKey: `dataset-success-${result.revision.id}`,
    });

    const nextFeatureId = preferredFeatureId ?? editingSourceFeatureIdRef.current;
    const nextFeature = result.dataset.collection.features.find(
      (feature) => toFeatureId(feature as EditableFeature) === nextFeatureId
    ) as EditableFeature | undefined;

    if (nextFeature) {
      loadDraft(normalizeEditableFeature(nextFeature), toFeatureId(nextFeature));
    } else {
      clearDraft();
    }
  };

  const updateDraftProperty = (key: string, value: unknown): void => {
    if (!draftFeature) {
      return;
    }
    const nextProperties = { ...(isRecord(draftFeature.properties) ? draftFeature.properties : {}) };
    if (value === '' || value === null || typeof value === 'undefined' || (Array.isArray(value) && value.length === 0)) {
      const remainingProperties = Object.fromEntries(Object.entries(nextProperties).filter(([entryKey]) => entryKey !== key)) as Record<string, unknown>;
      writeDraftFeature({ ...draftFeature, properties: remainingProperties });
      return;
    }
    nextProperties[key] = value;
    writeDraftFeature({ ...draftFeature, properties: nextProperties });
  };

  const setDraftRoutingLocationAssociation = useCallback((nextLocationId: string): void => {
    if (!draftFeature) {
      return;
    }

    const currentProperties = isRecord(draftFeature.properties) ? draftFeature.properties : {};
    const normalizedLocationId = nextLocationId.trim();
    const nextProperties = { ...currentProperties };

    delete nextProperties.building_id;
    delete nextProperties.locationId;

    if (normalizedLocationId) {
      nextProperties.location_id = normalizedLocationId;
    } else {
      delete nextProperties.location_id;
    }

    writeDraftFeature({ ...draftFeature, properties: nextProperties });
  }, [draftFeature, writeDraftFeature]);

  const writeAccessPointDraftFeature = useCallback((feature: EditableFeature): void => {
    setAccessPointDraft(feature);
  }, []);

  const updateAccessPointDraftProperty = useCallback((key: string, value: unknown): void => {
    if (!accessPointDraft) {
      return;
    }

    const nextProperties = { ...(isRecord(accessPointDraft.properties) ? accessPointDraft.properties : {}) };
    if (value === '' || value === null || typeof value === 'undefined' || (Array.isArray(value) && value.length === 0)) {
      const remainingProperties = Object.fromEntries(
        Object.entries(nextProperties).filter(([entryKey]) => entryKey !== key)
      ) as Record<string, unknown>;
      writeAccessPointDraftFeature({ ...accessPointDraft, properties: remainingProperties });
      return;
    }

    nextProperties[key] = value;
    writeAccessPointDraftFeature({ ...accessPointDraft, properties: nextProperties });
  }, [accessPointDraft, writeAccessPointDraftFeature]);

  const writeConnectorDraftFeature = useCallback((feature: EditableFeature): void => {
    if (!activeAccessPointCoordinate) {
      setConnectorDraft(feature);
      return;
    }

    setConnectorDraft(pinConnectorGeometryToStart(feature, activeAccessPointCoordinate));
  }, [activeAccessPointCoordinate]);

  const updateConnectorDraftProperty = useCallback((key: string, value: unknown): void => {
    if (!connectorDraft) {
      return;
    }

    const nextProperties = { ...(isRecord(connectorDraft.properties) ? connectorDraft.properties : {}) };
    if (value === '' || value === null || typeof value === 'undefined' || (Array.isArray(value) && value.length === 0)) {
      const remainingProperties = Object.fromEntries(
        Object.entries(nextProperties).filter(([entryKey]) => entryKey !== key)
      ) as Record<string, unknown>;
      writeConnectorDraftFeature({ ...connectorDraft, properties: remainingProperties });
      return;
    }

    nextProperties[key] = value;
    writeConnectorDraftFeature({ ...connectorDraft, properties: nextProperties });
  }, [connectorDraft, writeConnectorDraftFeature]);

  const applyLinkedRoutingMutationResult = useCallback(async (
    result: MapDatasetMutationRecord<MapFeatureCollection>,
    successMessage: string,
    options?: {
      preferredAccessPointId?: string | null;
      preferredConnectorId?: string | null;
      clearAccessPoint?: boolean;
      clearConnector?: boolean;
    }
  ): Promise<void> => {
    setReferenceDataset(result.dataset);

    await writeCachedMapDataset(result.dataset);
    publishMapDatasetUpdated(result.dataset);
    await onLocationsChanged();

    if (result.warnings.length > 0) {
      showWarning(result.warnings.join(' '), {
        title: 'Validation warning',
        dedupeKey: `routing-linked-warning-${result.revision.id}`,
      });
    }

    showSuccess(successMessage, {
      title: 'Routing updated',
      dedupeKey: `routing-linked-success-${result.revision.id}`,
    });

    if (options?.clearAccessPoint) {
      clearAccessPointDraft();
    } else {
      const nextAccessPointId = options?.preferredAccessPointId ?? accessPointDraftSourceId;
      const nextAccessPoint = nextAccessPointId
        ? result.dataset.collection.features.find((feature) => toFeatureId(feature as EditableFeature) === nextAccessPointId)
        : null;

      if (nextAccessPoint) {
        setAccessPointDraft(normalizeEditableFeature(nextAccessPoint, nextAccessPointId ?? undefined));
        setAccessPointDraftSourceId(nextAccessPointId);
      } else if (nextAccessPointId) {
        clearAccessPointDraft();
      }
    }

    if (options?.clearConnector) {
      clearConnectorDraft();
    } else {
      const nextConnectorId = options?.preferredConnectorId ?? connectorDraftSourceId;
      const nextConnector = nextConnectorId
        ? result.dataset.collection.features.find((feature) => toFeatureId(feature as EditableFeature) === nextConnectorId)
        : null;

      if (nextConnector) {
        setConnectorDraft(normalizeEditableFeature(nextConnector, nextConnectorId ?? undefined));
        setConnectorDraftSourceId(nextConnectorId);
      } else if (nextConnectorId) {
        clearConnectorDraft();
      }
    }
  }, [
    accessPointDraftSourceId,
    clearAccessPointDraft,
    clearConnectorDraft,
    connectorDraftSourceId,
    onLocationsChanged,
    showSuccess,
    showWarning,
  ]);

  const handleCreateAccessPoint = useCallback((role: AccessPointRole): void => {
    if (!draftFeature || !liveLocationFeatureId) {
      return;
    }

    clearConnectorDraft();
    setAccessPointDraft(createLocationAccessPointFeature(draftFeature, role));
    setAccessPointDraftSourceId(null);
  }, [clearConnectorDraft, draftFeature, liveLocationFeatureId]);

  const handleSelectAccessPoint = useCallback((record: LocationAccessPointRecord): void => {
    clearConnectorDraft();
    setAccessPointDraft(normalizeEditableFeature(record.feature, record.featureId));
    setAccessPointDraftSourceId(record.featureId);
  }, [clearConnectorDraft]);

  const handleSaveAccessPoint = useCallback(async (): Promise<void> => {
    if (!canManageAccessPoints || !accessPointDraft || !liveLocationFeatureId) {
      return;
    }

    if (!getFeaturePoint(accessPointDraft)) {
      showWarning('Place the access point on the map before saving it.', {
        title: 'Missing access point geometry',
        dedupeKey: 'access-point-missing-geometry',
      });
      return;
    }

    const currentProperties = isRecord(accessPointDraft.properties) ? accessPointDraft.properties : {};
    const nextProperties: Record<string, unknown> = {
      ...currentProperties,
      kind: 'entrance',
      location_id: liveLocationFeatureId,
      access_role: readAccessPointRole(accessPointDraft),
    };
    delete nextProperties.locationId;
    delete nextProperties.building_id;

    const normalizedFeature = normalizeEditableFeature(
      { ...accessPointDraft, properties: nextProperties },
      accessPointDraftSourceId ?? undefined
    );

    setLinkedRoutingSaving(true);
    try {
      const result = accessPointDraftSourceId
        ? await updateAdminMapFeature<MapFeatureCollection>('routing', accessPointDraftSourceId, normalizedFeature)
        : await createAdminMapFeature<MapFeatureCollection>('routing', normalizedFeature);

      await applyLinkedRoutingMutationResult(
        result,
        accessPointDraftSourceId ? 'Access point updated and published.' : 'Access point created and published.',
        {
          preferredAccessPointId: toFeatureId(normalizedFeature),
          clearConnector: true,
        }
      );
    } catch (error) {
      showError(mutationErrorMessage(error), {
        title: 'Access point save failed',
        dedupeKey: `access-point-save-${accessPointDraftSourceId ?? 'new'}`,
      });
    } finally {
      setLinkedRoutingSaving(false);
    }
  }, [
    accessPointDraft,
    accessPointDraftSourceId,
    applyLinkedRoutingMutationResult,
    canManageAccessPoints,
    liveLocationFeatureId,
    showError,
    showWarning,
  ]);

  const handleOpenConnectorDraft = useCallback((): void => {
    if (!draftFeature || !activeAccessPointFeature || !accessPointDraftSourceId || !canCreateConnector) {
      return;
    }

    setConnectorDraft(createAccessPointConnectorFeature(draftFeature, activeAccessPointFeature));
    setConnectorDraftSourceId(null);
  }, [accessPointDraftSourceId, activeAccessPointFeature, canCreateConnector, draftFeature]);

  const handleSelectConnector = useCallback((record: AccessPointConnectorRecord): void => {
    setConnectorDraft(normalizeEditableFeature(record.feature, record.featureId));
    setConnectorDraftSourceId(record.featureId);
  }, []);

  const handleSaveConnector = useCallback(async (): Promise<void> => {
    if (!connectorDraft || !activeAccessPointCoordinate || !accessPointDraftSourceId || !liveLocationFeatureId) {
      return;
    }

    const currentProperties = isRecord(connectorDraft.properties) ? connectorDraft.properties : {};
    const nextProperties: Record<string, unknown> = {
      ...currentProperties,
      kind: 'edge',
      location_id: liveLocationFeatureId,
      access_point_id: accessPointDraftSourceId,
    };
    delete nextProperties.locationId;
    delete nextProperties.building_id;

    const normalizedFeature = pinConnectorGeometryToStart(
      normalizeEditableFeature(
        { ...connectorDraft, properties: nextProperties },
        connectorDraftSourceId ?? undefined
      ),
      activeAccessPointCoordinate
    );

    if (lineStringCoordinates(normalizedFeature).length < 2) {
      showWarning('Add at least one more point on the map to finish the connector line.', {
        title: 'Connector incomplete',
        dedupeKey: 'connector-incomplete',
      });
      return;
    }

    setLinkedRoutingSaving(true);
    try {
      const result = connectorDraftSourceId
        ? await updateAdminMapFeature<MapFeatureCollection>('routing', connectorDraftSourceId, normalizedFeature)
        : await createAdminMapFeature<MapFeatureCollection>('routing', normalizedFeature);

      await applyLinkedRoutingMutationResult(
        result,
        connectorDraftSourceId ? 'Connector updated and published.' : 'Connector created and published.',
        {
          preferredAccessPointId: accessPointDraftSourceId,
          preferredConnectorId: toFeatureId(normalizedFeature),
        }
      );
    } catch (error) {
      showError(mutationErrorMessage(error), {
        title: 'Connector save failed',
        dedupeKey: `connector-save-${connectorDraftSourceId ?? 'new'}`,
      });
    } finally {
      setLinkedRoutingSaving(false);
    }
  }, [
    accessPointDraftSourceId,
    activeAccessPointCoordinate,
    applyLinkedRoutingMutationResult,
    connectorDraft,
    connectorDraftSourceId,
    liveLocationFeatureId,
    showError,
    showWarning,
  ]);

  const executeDeleteLinkedRoutingFeature = useCallback(async (
    featureId: string,
    entityLabel: 'access point' | 'connector'
  ): Promise<void> => {
    const featureIds =
      entityLabel === 'access point'
        ? [featureId, ...selectedAccessPointConnectors.map((entry) => entry.featureId)]
        : [featureId];
    const deletePreview = getRoutingDeletePreview(featureIds);
    if (deletePreview?.validationErrors.length) {
      showError(deletePreview.validationErrors.join(' '), {
        title: entityLabel === 'access point' ? 'Access point delete blocked' : 'Connector delete blocked',
        dedupeKey: `${entityLabel.replace(' ', '-')}-delete-blocked-${featureId}`,
      });
      return;
    }

    setPendingAction(null);
    setLinkedRoutingSaving(true);
    try {
      const result = entityLabel === 'access point'
        ? (featureIds.length === 1
            ? deleteAdminMapFeature<MapFeatureCollection>('routing', featureId)
            : bulkDeleteAdminMapDatasetFeatures<MapFeatureCollection>('routing', featureIds))
        : deleteAdminMapFeature<MapFeatureCollection>('routing', featureId);
      await applyLinkedRoutingMutationResult(
        await result,
        entityLabel === 'access point'
          ? selectedAccessPointConnectors.length > 0
            ? 'Access point and linked connectors deleted and published.'
            : 'Access point deleted and published.'
          : 'Connector deleted and published.',
        entityLabel === 'access point'
          ? { clearAccessPoint: true, clearConnector: true }
          : { preferredAccessPointId: accessPointDraftSourceId, clearConnector: true }
      );
    } catch (error) {
      showError(mutationErrorMessage(error), {
        title: entityLabel === 'access point' ? 'Access point delete failed' : 'Connector delete failed',
        dedupeKey: `${entityLabel.replace(' ', '-')}-delete-${featureId}`,
      });
    } finally {
      setLinkedRoutingSaving(false);
    }
  }, [accessPointDraftSourceId, applyLinkedRoutingMutationResult, getRoutingDeletePreview, selectedAccessPointConnectors, showError]);

  const handleDeleteAccessPoint = useCallback((): void => {
    if (!accessPointDraftSourceId) {
      clearAccessPointDraft();
      clearConnectorDraft();
      return;
    }

    const label = featureTitle(accessPointDraft ?? selectedAccessPointRecord?.feature ?? draftFeature ?? {
      type: 'Feature',
      id: accessPointDraftSourceId,
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    });
    const featureIds = [accessPointDraftSourceId, ...selectedAccessPointConnectors.map((entry) => entry.featureId)];
    const deletePreview = getRoutingDeletePreview(featureIds);
    if (deletePreview?.validationErrors.length) {
      showError(deletePreview.validationErrors.join(' '), {
        title: 'Access point delete blocked',
        dedupeKey: `access-point-delete-blocked-${accessPointDraftSourceId}`,
      });
      return;
    }

    setPendingAction({
      open: true,
      title: 'Delete access point?',
      message: withRoutingClearFallbackMessage(
        selectedAccessPointConnectors.length > 0
          ? `Delete ${label} and its ${selectedAccessPointConnectors.length} linked connector(s) from the live routing dataset? This publishes immediately.`
          : `Delete ${label} from the live routing dataset? This publishes immediately.`,
        Boolean(deletePreview?.isEmptyGraph)
      ),
      confirmLabel: 'Delete access point',
      tone: 'danger',
      action: {
        kind: 'delete-linked-access-point',
        featureId: accessPointDraftSourceId,
        label,
      },
    });
  }, [
    accessPointDraft,
    accessPointDraftSourceId,
    clearAccessPointDraft,
    clearConnectorDraft,
    draftFeature,
    getRoutingDeletePreview,
    selectedAccessPointConnectors,
    selectedAccessPointRecord,
    showError,
  ]);

  const handleDeleteConnector = useCallback((): void => {
    if (!connectorDraftSourceId) {
      clearConnectorDraft();
      return;
    }

    const label = featureTitle(connectorDraft ?? selectedConnectorRecord?.feature ?? {
      type: 'Feature',
      id: connectorDraftSourceId,
      geometry: { type: 'LineString', coordinates: [] },
      properties: {},
    });
    const deletePreview = getRoutingDeletePreview([connectorDraftSourceId]);
    if (deletePreview?.validationErrors.length) {
      showError(deletePreview.validationErrors.join(' '), {
        title: 'Connector delete blocked',
        dedupeKey: `connector-delete-blocked-${connectorDraftSourceId}`,
      });
      return;
    }

    setPendingAction({
      open: true,
      title: 'Delete connector?',
      message: withRoutingClearFallbackMessage(
        `Delete ${label} from the live routing dataset? This publishes immediately.`,
        Boolean(deletePreview?.isEmptyGraph)
      ),
      confirmLabel: 'Delete connector',
      tone: 'danger',
      action: {
        kind: 'delete-linked-connector',
        featureId: connectorDraftSourceId,
        label,
      },
    });
  }, [clearConnectorDraft, connectorDraft, connectorDraftSourceId, getRoutingDeletePreview, selectedConnectorRecord, showError]);

  const updateDraftId = (value: string): void => {
    if (!draftFeature) {
      return;
    }
    writeDraftFeature({ ...draftFeature, id: value.trim() });
  };

  const handleDraftTextChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const nextText = event.target.value;
    setDraftText(nextText);
    try {
      const parsed = JSON.parse(nextText);
      const normalized = normalizeEditableFeature(parsed, editingSourceFeatureId ?? undefined);
      setDraftFeature(normalized);
      setDraftTextError(null);
    } catch (error) {
      setDraftTextError(mutationErrorMessage(error));
    }
  };

  const handleDatasetTypeChange = (nextDatasetType: MapDatasetType): void => {
    if (nextDatasetType === datasetType) {
      return;
    }
    guardTransition({ kind: 'dataset', nextDatasetType }, 'Switch dataset?', 'Switching datasets discards unsaved changes in the current draft.', 'Switch dataset');
  };

  const handleCreateNewDraft = (geometryType: EditableGeometryType): void => {
    loadDraft(createEmptyFeature(datasetType, geometryType), '', null);
  };

  const handleDraftGeometryTypeChange = (geometryType: EditableGeometryType): void => {
    if (!draftFeature || draftFeature.geometry.type === geometryType) {
      return;
    }
    const nextProperties = { ...(isRecord(draftFeature.properties) ? draftFeature.properties : {}) };
    if (datasetType === 'routing') {
      if (geometryType === 'Point' && nextProperties.kind === 'edge') nextProperties.kind = 'node';
      if (geometryType === 'LineString' && nextProperties.kind === 'node') nextProperties.kind = 'edge';
    }
    writeDraftFeature({ ...draftFeature, geometry: createGeometryTemplate(geometryType), properties: nextProperties });
  };

  const confirmImport = (
    collection: MapFeatureCollection,
    importOptions?: MapDatasetImportOptions | null,
    message?: string
  ): void => {
    setPendingAction({
      open: true,
      title: 'Import GeoJSON now?',
      message:
        message ||
        `Bulk publish ${collection.features.length} feature(s) into the live ${formatDatasetLabel(datasetType).toLowerCase()} dataset? This runs immediately.`,
      confirmLabel: 'Import and publish',
      action: { kind: 'import', collection, importOptions: importOptions ?? null },
    });
  };

  const confirmBundleImport = (
    bundle: MapDatasetBundleInput<MapFeatureCollection>,
    importOptions?: MapDatasetImportOptions | null,
    message?: string
  ): void => {
    setPendingAction({
      open: true,
      title: 'Import bundle now?',
      message:
        message ||
        `Publish ${bundle.locations.features.length} location feature(s) and ${bundle.routing.features.length} routing feature(s) together? This updates both live datasets immediately.`,
      confirmLabel: 'Import bundle',
      action: { kind: 'import-bundle', bundle, importOptions: importOptions ?? null },
    });
  };

  const finalizeLocationImportSetup = (): void => {
    if (!locationImportSetup || !locationImportPreview) {
      return;
    }

    const sourceLabel = locationImportSetup.selectedSourceProperty
      ? `Use "${locationImportSetup.selectedSourceProperty}" for ${locationImportPreview.mappedFromSourceCount} missing feature(s).`
      : 'No source field selected for missing categories.';
    const fallbackLabel =
      locationImportPreview.fallbackCount > 0
        ? ` ${locationImportPreview.fallbackCount} feature(s) will fall back to Location.`
        : '';

    confirmImport(
      locationImportSetup.collection,
      {
        typeSourceProperty: locationImportSetup.selectedSourceProperty || null,
        typeFallback: 'Location',
      },
      `Bulk publish ${locationImportSetup.collection.features.length} feature(s) into the live ${formatDatasetLabel(datasetType).toLowerCase()} dataset? ${sourceLabel}${fallbackLabel}`.trim()
    );
  };

  const finalizeBundleImportSetup = (): void => {
    if (!bundleImportSetup || !bundleLocationImportPreview) {
      return;
    }

    if (bundleRoutingImportPreview?.errors.length) {
      showError('Resolve the routing validation errors before publishing this bundle.', {
        title: 'Routing validation',
        dedupeKey: 'bundle-routing-validation-errors',
      });
      return;
    }

    const sourceLabel = bundleImportSetup.selectedLocationSourceProperty
      ? `Use "${bundleImportSetup.selectedLocationSourceProperty}" for ${bundleLocationImportPreview.mappedFromSourceCount} missing location category value(s).`
      : 'No source field selected for missing location categories.';
    const fallbackLabel =
      bundleLocationImportPreview.fallbackCount > 0
        ? ` ${bundleLocationImportPreview.fallbackCount} location feature(s) will fall back to Location.`
        : '';
    const routingLabelParts = [
      bundleRoutingImportPreview?.autoConnectedWarnings.length
        ? `${bundleRoutingImportPreview.autoConnectedWarnings.length} routing entrance(s) will auto-connect to nearby walkways.`
        : '',
      bundleRoutingImportPreview?.unreachableWarnings.length
        ? `${bundleRoutingImportPreview.unreachableWarnings.length} routing entrance(s) are still too far from any walkway.`
        : '',
    ].filter(Boolean);

    confirmBundleImport(
      bundleImportSetup.bundle,
      {
        typeSourceProperty: bundleImportSetup.selectedLocationSourceProperty || null,
        typeFallback: 'Location',
      },
      `Publish ${bundleImportSetup.bundle.locations.features.length} location feature(s) and ${bundleImportSetup.bundle.routing.features.length} routing feature(s) together? ${sourceLabel}${fallbackLabel}${routingLabelParts.length > 0 ? ` ${routingLabelParts.join(' ')}` : ''}`.trim()
    );
  };

  const finalizeRoutingImportSetup = (): void => {
    if (!routingImportSetup || !routingImportPreview) {
      return;
    }

    if (routingImportPreview.errors.length > 0) {
      showError('Resolve the routing validation errors before publishing this dataset.', {
        title: 'Routing validation',
        dedupeKey: 'routing-import-validation-errors',
      });
      return;
    }

    const routingLabelParts = [
      routingImportPreview.autoConnectedWarnings.length
        ? `${routingImportPreview.autoConnectedWarnings.length} entrance(s) will auto-connect to nearby walkways.`
        : '',
      routingImportPreview.unreachableWarnings.length
        ? `${routingImportPreview.unreachableWarnings.length} entrance(s) are still too far from any walkway and may remain unroutable.`
        : '',
    ].filter(Boolean);

    confirmImport(
      routingImportSetup.collection,
      null,
      `Bulk publish ${routingImportSetup.collection.features.length} feature(s) into the live ${formatDatasetLabel(datasetType).toLowerCase()} dataset?${routingLabelParts.length > 0 ? ` ${routingLabelParts.join(' ')}` : ''}`.trim()
    );
  };

  const handleSaveFeature = async (): Promise<void> => {
    if (!enabled) {
      showWarning('Sign in to publish dataset changes.', { title: 'Write access required', dedupeKey: 'dataset-auth-required' });
      return;
    }
    if (!draftFeature) {
      showWarning('Choose or create a feature before publishing.', { title: 'No active feature', dedupeKey: 'dataset-no-draft' });
      return;
    }
    if (draftTextError) {
      showError('Resolve the JSON error before publishing.', { title: 'Invalid feature JSON', dedupeKey: 'dataset-invalid-json' });
      return;
    }

    setSaving(true);
    try {
      const normalizedFeature = normalizeEditableFeature(draftFeature, editingSourceFeatureId ?? undefined);
      const result = editingSourceFeatureId
        ? await updateAdminMapFeature<MapFeatureCollection>(datasetType, editingSourceFeatureId, normalizedFeature)
        : await createAdminMapFeature<MapFeatureCollection>(datasetType, normalizedFeature);
      await applyMutationResult(result, editingSourceFeatureId ? 'Feature updated and published.' : 'Feature created and published.', toFeatureId(normalizedFeature));
    } catch (error) {
      showError(mutationErrorMessage(error), { title: 'Publish failed', dedupeKey: `dataset-save-${datasetType}` });
    } finally {
      setSaving(false);
    }
  };

  const executeBulkImport = async (
    collection: MapFeatureCollection,
    importOptions?: MapDatasetImportOptions | null
  ): Promise<void> => {
    setPendingAction(null);
    setSaving(true);
    try {
      const result = await bulkUpsertAdminMapDataset<MapFeatureCollection>(
        datasetType,
        collection,
        importOptions
      );
      await applyMutationResult(result, `${collection.features.length} feature(s) processed and published.`, null);
    } catch (error) {
      const message = mutationErrorMessage(error).includes('missing properties.type')
        ? 'Choose a field to map into category before publishing this GeoJSON.'
        : mutationErrorMessage(error);
      showError(message, { title: 'Import failed', dedupeKey: `dataset-upload-${datasetType}` });
    } finally {
      setSaving(false);
    }
  };

  const executeBundleImport = async (
    bundle: MapDatasetBundleInput<MapFeatureCollection>,
    importOptions?: MapDatasetImportOptions | null
  ): Promise<void> => {
    setPendingAction(null);
    setSaving(true);
    try {
      const result = await bulkImportAdminMapBundle<MapFeatureCollection>(bundle, importOptions);
      clearLocationImportSetup();
      clearBundleImportSetup();

      await writeCachedMapDataset(result.locations.dataset);
      await writeCachedMapDataset(result.routing.dataset);
      publishMapDatasetUpdated(result.locations.dataset);
      publishMapDatasetUpdated(result.routing.dataset);
      await onLocationsChanged();
      await hydrateWorkspace();

      const warnings = [
        ...result.locations.warnings.map((warning) => `Locations: ${warning}`),
        ...result.routing.warnings.map((warning) => `Routing: ${warning}`),
      ];

      if (warnings.length > 0) {
        showWarning(warnings.join(' '), {
          title: 'Validation warning',
          dedupeKey: `bundle-warning-${result.locations.revision.id}-${result.routing.revision.id}`,
        });
      }

      showSuccess(
        `Bundle imported: ${bundle.locations.features.length} location feature(s) and ${bundle.routing.features.length} routing feature(s) published.`,
        {
          title: 'Datasets updated',
          dedupeKey: `bundle-success-${result.locations.revision.id}-${result.routing.revision.id}`,
        }
      );
    } catch (error) {
      showError(mutationErrorMessage(error), {
        title: 'Bundle import failed',
        dedupeKey: 'dataset-bundle-upload',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteFeature = async (confirmed = false): Promise<void> => {
    if (!draftFeature || !editingSourceFeatureId) {
      return;
    }

    const deletePreview = datasetType === 'routing' ? getRoutingDeletePreview([editingSourceFeatureId]) : null;
    if (deletePreview?.validationErrors.length) {
      showError(deletePreview.validationErrors.join(' '), {
        title: 'Delete blocked',
        dedupeKey: `dataset-delete-blocked-${editingSourceFeatureId}`,
      });
      return;
    }

    if (!confirmed) {
      setPendingAction({
        open: true,
        title: 'Delete live feature?',
        message: withRoutingClearFallbackMessage(
          `Delete ${featureTitle(draftFeature)} from the live ${formatDatasetLabel(datasetType).toLowerCase()} dataset? This publishes immediately.`,
          Boolean(deletePreview?.isEmptyGraph)
        ),
        confirmLabel: 'Delete feature',
        tone: 'danger',
        action: { kind: 'delete-feature' },
      });
      return;
    }

    setPendingAction(null);
    setSaving(true);
    try {
      const result = await deleteAdminMapFeature<MapFeatureCollection>(datasetType, editingSourceFeatureId);
      await applyMutationResult(result, 'Feature deleted and published.', null);
      setViewMode('utilities');
      setUtilityView('delete');
    } catch (error) {
      showError(mutationErrorMessage(error), { title: 'Delete failed', dedupeKey: `dataset-delete-${datasetType}-${editingSourceFeatureId}` });
    } finally {
      setSaving(false);
    }
  };

  const handleBulkDelete = async (confirmed = false): Promise<void> => {
    if (selectedFeatureIds.length === 0) {
      showWarning('Select at least one feature first.', { title: 'Nothing selected', dedupeKey: `dataset-bulk-delete-empty-${datasetType}` });
      return;
    }

    const deletePreview = datasetType === 'routing' ? getRoutingDeletePreview(selectedFeatureIds) : null;
    if (deletePreview?.validationErrors.length) {
      showError(deletePreview.validationErrors.join(' '), {
        title: 'Bulk delete blocked',
        dedupeKey: `dataset-bulk-delete-blocked-${datasetType}`,
      });
      return;
    }

    if (!confirmed) {
      setPendingAction({
        open: true,
        title: 'Delete selected features?',
        message: withRoutingClearFallbackMessage(
          `Delete ${selectedFeatureIds.length} selected feature(s) from the live ${formatDatasetLabel(datasetType).toLowerCase()} dataset? This publishes immediately.`,
          Boolean(deletePreview?.isEmptyGraph)
        ),
        confirmLabel: 'Delete selected',
        tone: 'danger',
        action: { kind: 'bulk-delete' },
      });
      return;
    }

    setPendingAction(null);
    setSaving(true);
    try {
      const result = await bulkDeleteAdminMapDatasetFeatures<MapFeatureCollection>(datasetType, selectedFeatureIds);
      await applyMutationResult(result, `${selectedFeatureIds.length} feature(s) deleted and published.`, null);
    } catch (error) {
      showError(mutationErrorMessage(error), { title: 'Bulk delete failed', dedupeKey: `dataset-bulk-delete-${datasetType}` });
    } finally {
      setSaving(false);
    }
  };

  const handleUploadFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      clearLocationImportSetup();
      clearRoutingImportSetup();
      clearBundleImportSetup();

      try {
        const normalizedBundle = normalizeDatasetBundleUpload(parsed);
        const missingLocationTypeCount = countLocationFeaturesMissingType(normalizedBundle.locations);
        const locationCandidateFields = collectLocationTypeCandidateFields(normalizedBundle.locations);
        setBundleImportSetup({
          fileName: file.name,
          bundle: normalizedBundle,
          missingLocationTypeCount,
          locationCandidateFields,
          selectedLocationSourceProperty: locationCandidateFields[0] ?? '',
        });
        return;
      } catch {
        // Fall through to single-dataset import handling.
      }

      try {
        const normalizedMixedBundle = normalizeMixedFeatureCollectionUpload(parsed);
        const missingLocationTypeCount = countLocationFeaturesMissingType(normalizedMixedBundle.locations);
        const locationCandidateFields = collectLocationTypeCandidateFields(normalizedMixedBundle.locations);
        setBundleImportSetup({
          fileName: file.name,
          bundle: normalizedMixedBundle,
          missingLocationTypeCount,
          locationCandidateFields,
          selectedLocationSourceProperty: locationCandidateFields[0] ?? '',
        });
        return;
      } catch {
        // Fall through to single-dataset import handling.
      }

      const normalizedCollection = normalizeFeatureCollection(parsed);

      if (datasetType === 'locations') {
        const missingTypeCount = countLocationFeaturesMissingType(normalizedCollection);

        if (missingTypeCount > 0) {
          const candidateFields = collectLocationTypeCandidateFields(normalizedCollection);
          setLocationImportSetup({
            fileName: file.name,
            collection: normalizedCollection,
            missingTypeCount,
            candidateFields,
            selectedSourceProperty: candidateFields[0] ?? '',
          });
          return;
        }
      }

      if (datasetType === 'routing') {
        setRoutingImportSetup({
          fileName: file.name,
          collection: normalizedCollection,
        });
        return;
      }

      confirmImport(normalizedCollection);
    } catch (error) {
      showError(mutationErrorMessage(error), { title: 'Import failed', dedupeKey: `dataset-upload-${datasetType}` });
    } finally {
      setSaving(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRestoreRevision = async (revision: MapDatasetRevisionRecord, confirmed = false): Promise<void> => {
    if (!confirmed) {
      setPendingAction({
        open: true,
        title: 'Restore this revision?',
        message: `Restore the ${formatAbsoluteTime(revision.createdAt)} ${formatDatasetLabel(datasetType).toLowerCase()} revision? This publishes immediately.`,
        confirmLabel: 'Restore revision',
        action: { kind: 'restore', revision },
      });
      return;
    }

    setPendingAction(null);
    setSaving(true);
    try {
      const result = await restoreAdminMapDatasetRevision<MapFeatureCollection>(datasetType, revision.id);
      await applyMutationResult(result, 'Revision restored and published.', null);
    } catch (error) {
      showError(mutationErrorMessage(error), { title: 'Restore failed', dedupeKey: `dataset-restore-${revision.id}` });
    } finally {
      setSaving(false);
    }
  };

  const reviewFields = useMemo(() => {
    if (!draftFeature) {
      return [];
    }
    if (datasetType === 'locations') {
      return [
        { label: 'Name', value: readStringProperty(draftFeature, 'name') || featureTitle(draftFeature) },
        { label: 'Type', value: readStringProperty(draftFeature, 'type') || featureSubtitle(draftFeature) },
        { label: 'Campus', value: readStringProperty(draftFeature, 'campus_id') || clientConfig.campus_id },
        { label: 'Status', value: readStringProperty(draftFeature, 'status') || '-' },
        { label: 'Routing access', value: readStringProperty(draftFeature, 'routing_access') || 'auto' },
      ];
    }
    return [
      { label: 'Name', value: readStringProperty(draftFeature, 'name') || featureTitle(draftFeature) },
      { label: 'Kind', value: readStringProperty(draftFeature, 'kind') || featureSubtitle(draftFeature) },
      { label: 'From', value: readStringProperty(draftFeature, 'from') || '-' },
      { label: 'To', value: readStringProperty(draftFeature, 'to') || '-' },
    ];
  }, [datasetType, draftFeature]);

  if (!enabled) {
    return (
      <AdminSectionCard label="Dataset manager" title="Live map data is locked">
        <AdminEmptyState title="Admin access required" message="Sign in to edit, import, delete, or restore dataset features." />
      </AdminSectionCard>
    );
  }

  return (
    <div className="space-y-5 pb-28">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">Dataset manager</p>
          <h2 className="mt-2 font-['Outfit'] text-3xl font-semibold text-slate-950">Live map data</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <AdminStatusBadge tone="info">{formatDatasetLabel(datasetType)}</AdminStatusBadge>
            <AdminStatusBadge>{liveFeatureCount} live feature(s)</AdminStatusBadge>
            {dataset ? <AdminStatusBadge>{formatRelativeTime(dataset.updatedAt)}</AdminStatusBadge> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {viewMode === 'utilities' ? (
            <button type="button" onClick={() => guardTransition({ kind: 'intent', nextIntent: intent ?? 'edit-existing' }, 'Leave utilities?', 'Leaving utilities takes you back to the task flow. Your draft is saved.', 'Back to tasks')} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950">Tasks</button>
          ) : null}
          {viewMode !== 'utilities' ? (
            <button type="button" onClick={() => guardTransition({ kind: 'utilities', nextUtilityView: utilityView }, 'Open utilities?', 'Opening utilities leaves the current flow but keeps your draft in place.', 'Open utilities')} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950">Utilities</button>
          ) : null}
          <button type="button" onClick={() => { void hydrateWorkspace(); }} disabled={loading || saving} className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">{loading ? 'Refreshing...' : 'Refresh'}</button>
        </div>
      </div>

      {viewMode === 'landing' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <button type="button" onClick={() => applyTransition({ kind: 'intent', nextIntent: 'edit-existing' })} className="rounded-[28px] border border-sky-200 bg-white px-5 py-5 text-left shadow-sm transition hover:border-sky-300 hover:bg-sky-50">
            <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-800">Start here</span>
            <h3 className="mt-4 font-['Outfit'] text-2xl font-semibold text-slate-950">Edit existing</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Find a live feature and update it.</p>
          </button>
          <button type="button" onClick={() => applyTransition({ kind: 'intent', nextIntent: 'create-new' })} className="rounded-[28px] border border-emerald-200 bg-white px-5 py-5 text-left shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50">
            <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-800">Start here</span>
            <h3 className="mt-4 font-['Outfit'] text-2xl font-semibold text-slate-950">Create new</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Start from a geometry type.</p>
          </button>
          <button type="button" onClick={() => applyTransition({ kind: 'utilities', nextUtilityView: 'import' })} className="rounded-[28px] border border-amber-200 bg-white px-5 py-5 text-left shadow-sm transition hover:border-amber-300 hover:bg-amber-50">
            <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-800">Start here</span>
            <h3 className="mt-4 font-['Outfit'] text-2xl font-semibold text-slate-950">Import GeoJSON</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Bulk publish from a file.</p>
          </button>
        </div>
      ) : null}

      {viewMode === 'wizard' && intent ? (
        <>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {currentSteps.map((label, index) => (
              <StepPill key={label} index={index} label={label} active={wizardStep === index} complete={wizardStep > index} />
            ))}
          </div>

          {intent === 'edit-existing' && wizardStep === 0 ? (
            <AdminSectionCard title="Choose a live feature" description="Pick a dataset and open one feature.">
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  {(['locations', 'routing'] as MapDatasetType[]).map((option) => (
                    <button key={option} type="button" onClick={() => handleDatasetTypeChange(option)} className={cx('rounded-2xl border px-4 py-4 text-left transition', datasetType === option ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50')}>
                      <p className="text-sm font-semibold text-slate-950">{formatDatasetLabel(option)}</p>
                      <p className="mt-2 text-xs text-slate-500">{option === 'locations' ? 'Places and areas' : 'Nodes and paths'}</p>
                    </button>
                  ))}
                </div>
                <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={datasetType === 'locations' ? 'Search by name, id, type, short code...' : 'Search by node, from, to, location id...'} />
                <div className="flex flex-wrap items-center gap-2">
                  <AdminStatusBadge>{filteredFeatures.length} result(s)</AdminStatusBadge>
                  {selectedCount > 0 ? <AdminStatusBadge tone="warning">{selectedCount} selected</AdminStatusBadge> : null}
                  {draftFeature && editingSourceFeatureId ? <AdminStatusBadge tone="info">{featureTitle(draftFeature)} open</AdminStatusBadge> : null}
                  <label className={cx('inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition', filteredFeatureIds.length > 0 ? 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-950' : 'border-slate-200 bg-slate-100 text-slate-400')}>
                    <input
                      ref={selectAllCheckboxRef}
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAllFiltered}
                      disabled={filteredFeatureIds.length === 0}
                      className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                      aria-label="Select all visible features"
                    />
                    {searchQuery.trim() ? 'Select all shown' : 'Select all'}
                  </label>
                </div>
                <div className="max-h-[540px] space-y-3 overflow-y-auto pr-1">
                  {loading ? (
                    <PanelSkeleton
                      title="Loading live features"
                      subtitle="Bringing the current dataset into the editor while keeping the utility panel stable."
                      lines={5}
                    />
                  ) : filteredFeatures.length === 0 ? (
                    <AdminEmptyState title="No matches" message="Try a different search or switch datasets." />
                  ) : (
                    filteredFeatures.map((feature) => {
                      const featureId = toFeatureId(feature);
                      const active = activeFeatureId === featureId;
                      const selected = selectedFeatureIds.includes(featureId);
                      return (
                        <article key={featureId} className={cx('rounded-[24px] border px-4 py-4 transition', active ? 'border-sky-300 bg-sky-50/70 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50')}>
                          <div className="flex items-start gap-3">
                            <input type="checkbox" checked={selected} onChange={() => toggleSelectedFeature(featureId)} className="mt-1 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500" aria-label={`Select ${featureTitle(feature)}`} />
                          <button type="button" onClick={() => loadDraft(feature, featureId)} className="min-w-0 flex-1 text-left">
                              <div className="flex flex-wrap items-center gap-2">
                                <AdminStatusBadge tone="info">{feature.geometry.type}</AdminStatusBadge>
                                <AdminStatusBadge>{featureSubtitle(feature)}</AdminStatusBadge>
                              </div>
                              <h3 className="mt-3 truncate font-['Outfit'] text-xl font-semibold text-slate-950">{featureTitle(feature)}</h3>
                              <p className="mt-2 text-sm leading-6 text-slate-600">{featureMetaSummary(datasetType, feature)}</p>
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </div>
            </AdminSectionCard>
          ) : null}

          {intent === 'create-new' && wizardStep === 0 ? (
            <AdminSectionCard title="Choose dataset and geometry" description="Start with the shape you need.">
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-2">
                  {(['locations', 'routing'] as MapDatasetType[]).map((option) => (
                    <button key={option} type="button" onClick={() => handleDatasetTypeChange(option)} className={cx('rounded-2xl border px-4 py-4 text-left transition', datasetType === option ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50')}>
                      <p className="text-sm font-semibold text-slate-950">{formatDatasetLabel(option)}</p>
                      <p className="mt-2 text-xs text-slate-500">{option === 'locations' ? 'Places and areas' : 'Nodes and paths'}</p>
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {geometryOptions.map((option) => {
                    const active = draftFeature?.geometry.type === option.value;
                    return (
                      <button key={option.value} type="button" onClick={() => handleCreateNewDraft(option.value)} className={cx('rounded-[24px] border px-4 py-5 text-left transition', active ? 'border-sky-200 bg-sky-50 text-sky-900 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50')}>
                        <p className="text-sm font-semibold text-slate-950">{option.label}</p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{option.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </AdminSectionCard>
          ) : null}

          {wizardStep === 1 && draftFeature ? (
            <AdminSectionCard title="Edit core details" description="Update the essential fields.">
              <div className="space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminStatusBadge tone={isExistingFeature ? 'info' : 'success'}>{isExistingFeature ? 'Live feature' : 'New feature'}</AdminStatusBadge>
                    <AdminStatusBadge>{draftFeature.geometry.type}</AdminStatusBadge>
                    <AdminStatusBadge>{featureSubtitle(draftFeature)}</AdminStatusBadge>
                  </div>
                  <h3 className="mt-3 font-['Outfit'] text-2xl font-semibold text-slate-950">{featureTitle(draftFeature)}</h3>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <InputField label="Feature id" value={toFeatureId(draftFeature)} onChange={updateDraftId} />
                  {isLocationsDataset ? (
                    <>
                      {locationTextFields.map((field) => (
                        field.key === 'type' ? (
                          <PresetTextField
                            key={field.key}
                            label={field.label}
                            value={readStringProperty(draftFeature, field.key)}
                            options={LOCATION_TYPE_OPTIONS}
                            onChange={(nextValue) => updateDraftProperty(field.key, nextValue)}
                          />
                        ) : field.key === 'kind' ? (
                          <PresetTextField
                            key={field.key}
                            label={field.label}
                            value={readStringProperty(draftFeature, field.key)}
                            options={LOCATION_KIND_OPTIONS}
                            onChange={(nextValue) => updateDraftProperty(field.key, nextValue)}
                          />
                        ) : field.key === 'status' ? (
                          <PresetTextField
                            key={field.key}
                            label={field.label}
                            value={readStringProperty(draftFeature, field.key)}
                            options={LOCATION_STATUS_OPTIONS}
                            onChange={(nextValue) => updateDraftProperty(field.key, nextValue)}
                          />
                        ) : (
                          <InputField key={field.key} label={field.label} value={readStringProperty(draftFeature, field.key)} onChange={(nextValue) => updateDraftProperty(field.key, nextValue)} />
                        )
                      ))}
                      {locationNumberFields.map((field) => (
                        <InputField key={field.key} label={field.label} type="number" value={readNumberProperty(draftFeature, field.key)} onChange={(nextValue) => updateDraftProperty(field.key, nextValue === '' ? '' : Number(nextValue))} />
                      ))}
                      <SelectField
                        label="Routing access style"
                        value={readStringProperty(draftFeature, 'routing_access') || 'auto'}
                        options={[...ROUTING_ACCESS_OPTIONS]}
                        onChange={(nextValue) => updateDraftProperty('routing_access', nextValue)}
                      />
                      <PresetListField
                        label="Features"
                        value={readStringArrayValues(draftFeature, 'features')}
                        options={LOCATION_FEATURE_OPTIONS}
                        onChange={(nextValue) => updateDraftProperty('features', nextValue)}
                        fullWidth
                      />
                      <InputField label="Aliases" value={readStringArrayProperty(draftFeature, 'aliases')} onChange={(nextValue) => updateDraftProperty('aliases', parseStringList(nextValue))} fullWidth />
                      <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Routing access style</p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Auto infers whether this location should route through entrances or allow open-area access from any side. Use Open area for car parks, fields, and plazas. Use Entrance-based for enclosed places that must route through mapped access points.
                        </p>
                      </div>
                      <div id="dataset-access-points-section" className="md:col-span-2 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="max-w-3xl">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Access points</p>
                            <h4 className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-950">Manage building entrances and exits</h4>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              Access points are routing nodes linked to this building. Saving them publishes straight to the live routing dataset without changing the current building draft.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <AdminStatusBadge tone={canManageAccessPoints ? 'info' : 'warning'}>
                              {canManageAccessPoints ? `${locationAccessPoints.length} linked` : 'Locked'}
                            </AdminStatusBadge>
                            {selectedAccessPointRecord ? (
                              <AdminStatusBadge tone={accessPointStatusTone(selectedAccessPointRecord)}>
                                {accessPointStatusLabel(selectedAccessPointRecord)}
                              </AdminStatusBadge>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Immediate publish</p>
                          <p className="mt-2 text-sm leading-6 text-amber-900">
                            Entrance, exit, and connector changes publish to the live routing dataset immediately. The open building form still has its own separate publish button.
                          </p>
                        </div>

                        {!canManageAccessPoints ? (
                          <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
                            <p className="text-sm font-semibold text-slate-950">Access-point editing is unavailable right now.</p>
                            <p className="mt-2 text-sm leading-6 text-slate-600">{accessPointsLockedReason}</p>
                          </div>
                        ) : (
                          <>
                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => handleCreateAccessPoint('entrance')}
                                disabled={linkedRoutingSaving}
                                className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800 transition hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Add entrance
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCreateAccessPoint('exit')}
                                disabled={linkedRoutingSaving}
                                className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-800 transition hover:border-sky-300 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Add exit
                              </button>
                            </div>

                            <div className="mt-4 rounded-2xl border border-slate-200 bg-white">
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Linked access points</p>
                                <p className="text-xs text-slate-500">Select a point to edit its map placement and details.</p>
                              </div>
                              <div className="max-h-[280px] space-y-2 overflow-y-auto p-2">
                                {locationAccessPoints.length === 0 ? (
                                  <AdminEmptyState
                                    title="No access points yet"
                                    message="Add an entrance or exit to start linking this building to the routing graph."
                                  />
                                ) : (
                                  locationAccessPoints.map((record) => {
                                    const isSelected = accessPointDraftSourceId === record.featureId;
                                    return (
                                      <button
                                        key={record.featureId}
                                        type="button"
                                        onClick={() => handleSelectAccessPoint(record)}
                                        className={cx(
                                          'w-full rounded-2xl border px-4 py-3 text-left transition',
                                          isSelected
                                            ? 'border-sky-200 bg-sky-50'
                                            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                                        )}
                                        aria-pressed={isSelected}
                                      >
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold text-slate-950">{record.title}</p>
                                            <p className="mt-1 text-xs leading-5 text-slate-500">{record.featureId}</p>
                                          </div>
                                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                            <AdminStatusBadge>{accessPointRoleLabel(record.role)}</AdminStatusBadge>
                                            <AdminStatusBadge tone={accessPointStatusTone(record)}>
                                              {accessPointStatusLabel(record)}
                                            </AdminStatusBadge>
                                            {record.connectorCount > 0 ? (
                                              <AdminStatusBadge tone="info">
                                                {record.connectorCount} connector{record.connectorCount === 1 ? '' : 's'}
                                              </AdminStatusBadge>
                                            ) : null}
                                          </div>
                                        </div>
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            </div>

                            {accessPointDraft ? (
                              <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Access point editor</p>
                                    <h5 className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-950">{featureTitle(accessPointDraft)}</h5>
                                    <p className="mt-2 text-sm leading-6 text-slate-600">
                                      Place the point exactly at the door. Drag the marker to refine the position, then publish the routing node from here.
                                    </p>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <AdminStatusBadge>{accessPointRoleLabel(readAccessPointRole(accessPointDraft))}</AdminStatusBadge>
                                    <AdminStatusBadge tone={selectedAccessPointRecord ? accessPointStatusTone(selectedAccessPointRecord) : 'info'}>
                                      {selectedAccessPointRecord ? accessPointStatusLabel(selectedAccessPointRecord) : 'Draft'}
                                    </AdminStatusBadge>
                                    {isAccessPointDraftDirty ? (
                                      <AdminStatusBadge tone="warning">Unsaved changes</AdminStatusBadge>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="mt-4 grid gap-4 md:grid-cols-2">
                                  <InputField
                                    label="Access point name"
                                    value={readStringProperty(accessPointDraft, 'name')}
                                    onChange={(nextValue) => updateAccessPointDraftProperty('name', nextValue)}
                                  />
                                  <SelectField
                                    label="Role"
                                    value={readAccessPointRole(accessPointDraft)}
                                    options={ACCESS_ROLE_OPTIONS}
                                    onChange={(nextValue) => updateAccessPointDraftProperty('access_role', nextValue)}
                                  />
                                </div>

                                <div className="mt-4 flex flex-wrap gap-2">
                                  {routingBooleanFields.map((field) => (
                                    <ToggleField
                                      key={`access_${field.key}`}
                                      label={field.label}
                                      checked={readBooleanProperty(accessPointDraft, field.key)}
                                      onChange={(nextValue) => updateAccessPointDraftProperty(field.key, nextValue)}
                                    />
                                  ))}
                                </div>

                                <div className="mt-4">
                                  <AdminFeatureGeometryEditor
                                    feature={accessPointDraft}
                                    onFeatureChange={writeAccessPointDraftFeature}
                                    referenceFeatures={locationAccessEditorReferenceFeatures}
                                    activeFeatureId={toFeatureId(accessPointDraft)}
                                  />
                                </div>

                                <div className="mt-4 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => { void handleSaveAccessPoint(); }}
                                    disabled={linkedRoutingSaving}
                                    className="rounded-full bg-sky-600 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {linkedRoutingSaving ? 'Publishing...' : accessPointDraftSourceId ? 'Save access point' : 'Publish access point'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={handleOpenConnectorDraft}
                                    disabled={!canCreateConnector || linkedRoutingSaving}
                                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    Create connector
                                  </button>
                                  <button
                                    type="button"
                                    onClick={handleDeleteAccessPoint}
                                    disabled={linkedRoutingSaving}
                                    className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {accessPointDraftSourceId ? 'Delete access point' : 'Discard draft'}
                                  </button>
                                </div>
                                <p className="mt-3 text-xs leading-5 text-slate-500">
                                  {canCreateConnector
                                    ? 'Create a connector after the access point is saved and settled at the correct door position.'
                                    : 'Save this access point first before creating a connector, especially if you changed its map position.'}
                                </p>

                                {accessPointDraftSourceId ? (
                                  <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div>
                                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Connectors</p>
                                        <p className="mt-1 text-sm text-slate-600">Guided line helpers that tie this access point back into the path network.</p>
                                      </div>
                                      <AdminStatusBadge tone="info">
                                        {selectedAccessPointConnectors.length} connector{selectedAccessPointConnectors.length === 1 ? '' : 's'}
                                      </AdminStatusBadge>
                                    </div>

                                    {selectedAccessPointConnectors.length === 0 ? (
                                      <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
                                        No connector lines linked to this access point yet.
                                      </div>
                                    ) : (
                                      <div className="mt-3 space-y-2">
                                        {selectedAccessPointConnectors.map((connector) => {
                                          const selected = connectorDraftSourceId === connector.featureId;
                                          return (
                                            <div key={connector.featureId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
                                              <div className="min-w-0">
                                                <p className="truncate text-sm font-semibold text-slate-950">{connector.title}</p>
                                                <p className="mt-1 text-xs leading-5 text-slate-500">{connector.featureId}</p>
                                              </div>
                                              <div className="flex flex-wrap gap-2">
                                                <button
                                                  type="button"
                                                  onClick={() => handleSelectConnector(connector)}
                                                  className={cx(
                                                    'rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition',
                                                    selected
                                                      ? 'border-sky-200 bg-sky-50 text-sky-800'
                                                      : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-950'
                                                  )}
                                                >
                                                  {selected ? 'Editing' : 'Edit'}
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                ) : null}

                                {connectorDraft ? (
                                  <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                      <div>
                                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Connector editor</p>
                                        <h5 className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-950">{featureTitle(connectorDraft)}</h5>
                                        <p className="mt-2 text-sm leading-6 text-slate-600">
                                          The first line point is pinned to the selected access point. Click the map to extend the connector toward the nearest walkway.
                                        </p>
                                      </div>
                                      <AdminStatusBadge tone={connectorDraftSourceId ? 'info' : 'warning'}>
                                        {connectorDraftSourceId ? 'Live connector' : 'New connector'}
                                      </AdminStatusBadge>
                                    </div>

                                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                                      <InputField
                                        label="Connector name"
                                        value={readStringProperty(connectorDraft, 'name')}
                                        onChange={(nextValue) => updateConnectorDraftProperty('name', nextValue)}
                                      />
                                      <InputField
                                        label="Highway"
                                        value={readStringProperty(connectorDraft, 'highway')}
                                        onChange={(nextValue) => updateConnectorDraftProperty('highway', nextValue)}
                                      />
                                    </div>

                                    <div className="mt-4 flex flex-wrap gap-2">
                                      {routingBooleanFields.map((field) => (
                                        <ToggleField
                                          key={`connector_${field.key}`}
                                          label={field.label}
                                          checked={readBooleanProperty(connectorDraft, field.key)}
                                          onChange={(nextValue) => updateConnectorDraftProperty(field.key, nextValue)}
                                        />
                                      ))}
                                    </div>

                                    <div className="mt-4">
                                      <AdminFeatureGeometryEditor
                                        feature={connectorDraft}
                                        onFeatureChange={writeConnectorDraftFeature}
                                        referenceFeatures={locationAccessEditorReferenceFeatures}
                                        activeFeatureId={toFeatureId(connectorDraft)}
                                      />
                                    </div>

                                    <div className="mt-4 flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        onClick={() => { void handleSaveConnector(); }}
                                        disabled={linkedRoutingSaving}
                                        className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        {linkedRoutingSaving ? 'Publishing...' : connectorDraftSourceId ? 'Save connector' : 'Publish connector'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={handleDeleteConnector}
                                        disabled={linkedRoutingSaving}
                                        className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        {connectorDraftSourceId ? 'Delete connector' : 'Discard connector'}
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {isRoutingPointFeature ? (
                        <div className="md:col-span-2 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="max-w-2xl">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Associated location</p>
                              <h4 className="mt-2 font-['Outfit'] text-xl font-semibold text-slate-950">Link this routing point to a building</h4>
                              <p className="mt-2 text-sm leading-6 text-slate-600">
                                Search the live locations dataset by name, short code, or feature id, or use the one-click helpers to assign the containing or nearest building.
                              </p>
                            </div>
                            <AdminStatusBadge tone={resolvedRoutingAssociation ? 'success' : routingAssociationId ? 'warning' : 'info'}>
                              {resolvedRoutingAssociation ? 'Linked' : routingAssociationId ? 'Unresolved id' : 'Needs link'}
                            </AdminStatusBadge>
                          </div>

                          <div
                            className={cx(
                              'mt-4 rounded-2xl border px-4 py-4',
                              resolvedRoutingAssociation
                                ? 'border-emerald-200 bg-white'
                                : routingAssociationId
                                  ? 'border-amber-200 bg-white'
                                  : 'border-sky-200 bg-white'
                            )}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              {resolvedRoutingAssociation?.displayCode ? (
                                <AdminStatusBadge>{resolvedRoutingAssociation.displayCode}</AdminStatusBadge>
                              ) : null}
                              {resolvedRoutingAssociation?.featureType ? (
                                <AdminStatusBadge tone="info">{resolvedRoutingAssociation.featureType}</AdminStatusBadge>
                              ) : null}
                            </div>
                            <p className="mt-3 text-sm font-semibold text-slate-950">
                              {resolvedRoutingAssociation
                                ? `${resolvedRoutingAssociation.featureName} is linked to this routing point.`
                                : routingAssociationId
                                  ? `Current location id "${routingAssociationId}" does not match any live location feature.`
                                  : 'This routing point is not linked to a location yet.'}
                            </p>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              {resolvedRoutingAssociation
                                ? `Feature id: ${resolvedRoutingAssociation.featureId}`
                                : routingAssociationId
                                  ? 'Choose a building below or correct the raw location id to restore routing for this entrance or node.'
                                  : 'Routing to named places works best when entrances and destination nodes are linked to a location feature.'}
                            </p>
                          </div>

                          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_240px]">
                            <div className="space-y-3">
                              <SearchInput
                                label="Find building"
                                value={locationPickerQuery}
                                onChange={setLocationPickerQuery}
                                placeholder="Search by name, short code, or feature id..."
                              />
                              {locationAssociationOptions.length === 0 ? (
                                <AdminEmptyState
                                  title="No location options available"
                                  message="Load the locations dataset first. Routing-point association only works when the live locations dataset is available as a reference."
                                />
                              ) : (
                                <div className="rounded-2xl border border-slate-200 bg-white">
                                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Matching locations</p>
                                    <p className="text-xs text-slate-500">
                                      Showing {filteredLocationAssociationOptions.length} of {locationAssociationOptions.length}
                                    </p>
                                  </div>
                                  <div className="max-h-[320px] space-y-2 overflow-y-auto p-2">
                                    {filteredLocationAssociationOptions.length === 0 ? (
                                      <AdminEmptyState
                                        title="No building matches"
                                        message="Try a different search term, or use one of the auto-assign buttons if the point is already placed on the map."
                                      />
                                    ) : (
                                      filteredLocationAssociationOptions.map((option) => {
                                        const isSelected = routingAssociationId === option.featureId;
                                        return (
                                          <button
                                            key={option.featureId}
                                            type="button"
                                            onClick={() => setDraftRoutingLocationAssociation(option.featureId)}
                                            className={cx(
                                              'w-full rounded-2xl border px-4 py-3 text-left transition',
                                              isSelected
                                                ? 'border-emerald-200 bg-emerald-50'
                                                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                                            )}
                                            aria-pressed={isSelected}
                                          >
                                            <div className="flex items-start justify-between gap-3">
                                              <div className="min-w-0">
                                                <p className="truncate text-sm font-semibold text-slate-950">
                                                  {option.featureName}
                                                </p>
                                                <p className="mt-1 text-xs leading-5 text-slate-500">
                                                  {option.featureId}
                                                </p>
                                              </div>
                                              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                {option.displayCode ? (
                                                  <AdminStatusBadge>{option.displayCode}</AdminStatusBadge>
                                                ) : null}
                                                <AdminStatusBadge tone={isSelected ? 'success' : 'default'}>
                                                  {isSelected ? 'Selected' : option.featureType}
                                                </AdminStatusBadge>
                                              </div>
                                            </div>
                                          </button>
                                        );
                                      })
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="space-y-3">
                              <button
                                type="button"
                                onClick={() => {
                                  if (containingLocationSuggestion) {
                                    setDraftRoutingLocationAssociation(containingLocationSuggestion.option.featureId);
                                  }
                                }}
                                disabled={!containingLocationSuggestion}
                                className="w-full rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-left text-sm font-semibold text-sky-900 transition hover:border-sky-300 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Assign containing building
                              </button>
                              <p className="text-xs leading-5 text-slate-500">
                                {containingLocationSuggestion
                                  ? `${containingLocationSuggestion.option.featureName} contains this point on the map.`
                                  : 'No containing building polygon was found for the current point.'}
                              </p>

                              <button
                                type="button"
                                onClick={() => {
                                  if (nearestLocationSuggestion) {
                                    setDraftRoutingLocationAssociation(nearestLocationSuggestion.option.featureId);
                                  }
                                }}
                                disabled={!nearestLocationSuggestion}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-900 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Assign nearest building
                              </button>
                              <p className="text-xs leading-5 text-slate-500">
                                {nearestLocationSuggestion
                                  ? `${nearestLocationSuggestion.option.featureName} is ${Math.round(nearestLocationSuggestion.distanceMeters)}m away.`
                                  : `No nearby location was found within ${ROUTING_LOCATION_NEAREST_MATCH_MAX_DISTANCE_METERS}m.`}
                              </p>

                              <button
                                type="button"
                                onClick={() => setDraftRoutingLocationAssociation('')}
                                disabled={!routingAssociationId}
                                className="w-full rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-left text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Clear association
                              </button>
                              <p className="text-xs leading-5 text-slate-500">
                                Clear the link if this point should stay as an unassigned routing node.
                              </p>
                            </div>
                          </div>

                          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Advanced fallback</p>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              If you already know the exact location feature id, you can still type it directly here.
                            </p>
                            <div className="mt-3">
                              <InputField
                                label="Location id"
                                value={routingAssociationId}
                                onChange={setDraftRoutingLocationAssociation}
                                fullWidth
                              />
                            </div>
                          </div>
                        </div>
                      ) : null}
                      {routingTextFieldsForDraft.map((field) => (
                        <InputField key={field.key} label={field.label} value={readStringProperty(draftFeature, field.key)} onChange={(nextValue) => updateDraftProperty(field.key, nextValue)} fullWidth={'fullWidth' in field && Boolean(field.fullWidth)} />
                      ))}
                      <div className="flex flex-wrap gap-2 md:col-span-2">
                        {routingBooleanFields.map((field) => (
                          <ToggleField key={field.key} label={field.label} checked={readBooleanProperty(draftFeature, field.key)} onChange={(nextValue) => updateDraftProperty(field.key, nextValue)} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </AdminSectionCard>
          ) : null}

          {wizardStep === 2 && draftFeature ? (
            <AdminSectionCard title="Edit geometry" description="Adjust the shape and map placement.">
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {geometryOptions.map((option) => {
                    const active = draftFeature.geometry.type === option.value;
                    return (
                      <button key={option.value} type="button" onClick={() => handleDraftGeometryTypeChange(option.value)} className={cx('rounded-2xl border px-4 py-4 text-left transition', active ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50')}>
                        <p className="text-sm font-semibold">{option.label}</p>
                        <p className="mt-2 text-xs leading-5 text-slate-600">{option.description}</p>
                      </button>
                    );
                  })}
                </div>
                <AdminFeatureGeometryEditor
                  feature={draftFeature}
                  onFeatureChange={writeDraftFeature}
                  referenceFeatures={mapReferenceFeatures}
                  activeFeatureId={activeFeatureId}
                />
              </div>
            </AdminSectionCard>
          ) : null}

          {wizardStep === 3 && draftFeature ? (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
              <AdminSectionCard title="Review" description="Check the summary, then publish.">
                <div className="space-y-5">
                  <div className="rounded-[28px] border border-slate-200 bg-slate-50 px-5 py-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone={isExistingFeature ? 'info' : 'success'}>{isExistingFeature ? 'Update' : 'Create'}</AdminStatusBadge>
                      <AdminStatusBadge>{formatDatasetLabel(datasetType)}</AdminStatusBadge>
                      <AdminStatusBadge>{draftFeature.geometry.type}</AdminStatusBadge>
                    </div>
                    <h3 className="mt-3 font-['Outfit'] text-3xl font-semibold text-slate-950">{featureTitle(draftFeature)}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{featureMetaSummary(datasetType, draftFeature)}</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <SummaryField label="Geometry" value={geometrySummary(draftFeature)} />
                    {reviewFields.map((field) => <SummaryField key={field.label} label={field.label} value={field.value} />)}
                  </div>
                </div>
              </AdminSectionCard>
              <AdminSectionCard title="Before publish" description="Publishing updates the live dataset immediately.">
                <div className="space-y-4">
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Live update</p>
                    <p className="mt-2 text-sm leading-6 text-amber-900">A successful publish creates a new live revision right away.</p>
                  </div>
                  <button type="button" onClick={() => guardTransition({ kind: 'utilities', nextUtilityView: 'raw-json' }, 'Open utilities?', 'Opening utilities leaves the current flow but keeps your draft in place.', 'Open utilities')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300 hover:bg-slate-50">
                    <span><span className="block text-sm font-semibold text-slate-950">Open raw JSON</span><span className="mt-1 block text-xs leading-5 text-slate-600">Advanced editing stays in Utilities.</span></span>
                    <AdminStatusBadge>Advanced</AdminStatusBadge>
                  </button>
                  <button type="button" onClick={() => guardTransition({ kind: 'utilities', nextUtilityView: 'history' }, 'Open utilities?', 'Opening utilities leaves the current flow but keeps your draft in place.', 'Open utilities')} className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300 hover:bg-slate-50">
                    <span><span className="block text-sm font-semibold text-slate-950">Open history</span><span className="mt-1 block text-xs leading-5 text-slate-600">Restore a previous live revision if needed.</span></span>
                    <AdminStatusBadge tone="warning">History</AdminStatusBadge>
                  </button>
                </div>
              </AdminSectionCard>
            </div>
          ) : null}

          <WizardFooter
            stepLabel={`${currentSteps[wizardStep]} / ${formatDatasetLabel(datasetType)}`}
            onBack={handleWizardBack}
            onDiscard={() => applyTransition({ kind: 'landing' })}
            onNext={() => setWizardStep((current) => Math.min(3, current + 1) as WizardStep)}
            onPublish={() => { void handleSaveFeature(); }}
            nextDisabled={!canProceed}
            publishDisabled={!canPublish || saving}
            nextLabel={wizardStep === 3 ? '' : wizardStep === 2 ? 'Review' : 'Next'}
            publishLabel={publishLabel}
            onDelete={selectedCount > 0 ? () => { void handleBulkDelete(); } : undefined}
            onRawJson={selectedCount > 0 ? () => guardTransition({ kind: 'utilities', nextUtilityView: 'raw-json' }, 'Open utilities?', 'Opening utilities leaves the current flow but keeps your draft in place.', 'Open utilities') : undefined}
            deleteDisabled={saving}
            selectedCount={selectedCount}
          />
        </>
      ) : null}

      {viewMode === 'utilities' ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {utilityTabs.map((tab) => (
              <button key={tab.id} type="button" onClick={() => setUtilityView(tab.id)} className={cx('rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition', utilityView === tab.id ? 'border-sky-200 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-950')}>
                {tab.label}
              </button>
            ))}
          </div>

          {utilityView === 'import' ? (
            <AdminSectionCard title="Import GeoJSON" description="Bulk publish from a FeatureCollection file.">
              <div className="space-y-4">
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Immediate publish</p>
                  <p className="mt-2 text-sm leading-6 text-amber-900">Importing publishes to the live dataset immediately. You can upload a single dataset FeatureCollection, a mixed Overpass-style FeatureCollection, or a bundle file that contains both locations and routing collections.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {(['locations', 'routing'] as MapDatasetType[]).map((option) => (
                    <button key={option} type="button" onClick={() => handleDatasetTypeChange(option)} className={cx('rounded-2xl border px-4 py-4 text-left transition', datasetType === option ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50')}>
                      <p className="text-sm font-semibold text-slate-950">{formatDatasetLabel(option)}</p>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={saving} className="rounded-full bg-sky-600 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60">{saving ? 'Working...' : (locationImportSetup || bundleImportSetup) ? 'Choose another file' : 'Choose file'}</button>
                  {locationImportSetup || bundleImportSetup ? (
                    <button type="button" onClick={() => { clearLocationImportSetup(); clearBundleImportSetup(); }} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950">
                      Clear setup
                    </button>
                  ) : null}
                </div>
                {locationImportSetup && locationImportPreview ? (
                  <div className="space-y-4 rounded-[26px] border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone="info">{locationImportSetup.fileName}</AdminStatusBadge>
                      <AdminStatusBadge>{locationImportSetup.collection.features.length} feature(s)</AdminStatusBadge>
                      <AdminStatusBadge tone="warning">{locationImportSetup.missingTypeCount} missing type</AdminStatusBadge>
                    </div>
                    <div>
                      <h4 className="font-['Outfit'] text-xl font-semibold text-slate-950">Map a property into category</h4>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Missing <code>properties.type</code> values will use the selected field first, then fall back to <code>Location</code>.
                      </p>
                    </div>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Source field for missing type</span>
                      <select
                        value={locationImportSetup.selectedSourceProperty}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setLocationImportSetup((current) => current ? { ...current, selectedSourceProperty: nextValue } : current);
                        }}
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      >
                        <option value="">No mapped field, use Location fallback</option>
                        {locationImportSetup.candidateFields.map((field) => (
                          <option key={field} value={field}>
                            {field}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Mapped from field</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{locationImportPreview.mappedFromSourceCount}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Fallback to Location</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{locationImportPreview.fallbackCount}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Resolved categories</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{locationImportPreview.categoryCounts.length}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Preview categories</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {locationImportPreview.categoryCounts.slice(0, 8).map((entry) => (
                          <AdminStatusBadge key={entry.label}>{entry.label} ({entry.count})</AdminStatusBadge>
                        ))}
                        {locationImportPreview.categoryCounts.length === 0 ? (
                          <AdminStatusBadge>Location (0)</AdminStatusBadge>
                        ) : null}
                      </div>
                    </div>
                    {locationImportSetup.candidateFields.length === 0 ? (
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm leading-6 text-slate-600">
                        No category-like string fields were found in the uploaded features. Missing values will publish as <code>Location</code>.
                      </div>
                    ) : null}
                    <button type="button" onClick={finalizeLocationImportSetup} disabled={saving} className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                      {saving ? 'Working...' : 'Import resolved GeoJSON'}
                    </button>
                  </div>
                ) : null}
                {routingImportSetup && routingImportPreview ? (
                  <div className="space-y-4 rounded-[26px] border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone="info">{routingImportSetup.fileName}</AdminStatusBadge>
                      <AdminStatusBadge>{routingImportSetup.collection.features.length} feature(s)</AdminStatusBadge>
                    </div>
                    <RoutingValidationNotice
                      preview={routingImportPreview}
                      title="Routing connectivity preview"
                    />
                    <button
                      type="button"
                      onClick={finalizeRoutingImportSetup}
                      disabled={saving || routingImportPreview.errors.length > 0}
                      className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {saving ? 'Working...' : 'Import routing GeoJSON'}
                    </button>
                  </div>
                ) : null}
                {bundleImportSetup && bundleLocationImportPreview ? (
                  <div className="space-y-4 rounded-[26px] border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone="info">{bundleImportSetup.fileName}</AdminStatusBadge>
                      <AdminStatusBadge>{bundleImportSetup.bundle.locations.features.length} location feature(s)</AdminStatusBadge>
                      <AdminStatusBadge>{bundleImportSetup.bundle.routing.features.length} routing feature(s)</AdminStatusBadge>
                      <AdminStatusBadge tone="warning">{bundleImportSetup.missingLocationTypeCount} missing location type</AdminStatusBadge>
                    </div>
                    <div>
                      <h4 className="font-['Outfit'] text-xl font-semibold text-slate-950">Bundle import setup</h4>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        This bundle will publish both datasets together. The current dataset selector above does not limit the bundle import.
                      </p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Locations</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{bundleImportSetup.bundle.locations.features.length}</p>
                        <p className="mt-2 text-sm text-slate-600">Will update the live locations dataset.</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Routing</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{bundleImportSetup.bundle.routing.features.length}</p>
                        <p className="mt-2 text-sm text-slate-600">Will update the live routing dataset.</p>
                      </div>
                    </div>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Source field for missing location type</span>
                      <select
                        value={bundleImportSetup.selectedLocationSourceProperty}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setBundleImportSetup((current) => current ? { ...current, selectedLocationSourceProperty: nextValue } : current);
                        }}
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
                      >
                        <option value="">No mapped field, use Location fallback</option>
                        {bundleImportSetup.locationCandidateFields.map((field) => (
                          <option key={field} value={field}>
                            {field}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Mapped from field</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{bundleLocationImportPreview.mappedFromSourceCount}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Fallback to Location</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{bundleLocationImportPreview.fallbackCount}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Resolved location categories</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{bundleLocationImportPreview.categoryCounts.length}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Preview location categories</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {bundleLocationImportPreview.categoryCounts.slice(0, 8).map((entry) => (
                          <AdminStatusBadge key={entry.label}>{entry.label} ({entry.count})</AdminStatusBadge>
                        ))}
                        {bundleLocationImportPreview.categoryCounts.length === 0 ? (
                          <AdminStatusBadge>Location (0)</AdminStatusBadge>
                        ) : null}
                      </div>
                    </div>
                    {bundleImportSetup.locationCandidateFields.length === 0 ? (
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm leading-6 text-slate-600">
                        No category-like string fields were found in the location collection. Missing values will publish as <code>Location</code>.
                      </div>
                    ) : null}
                    {bundleRoutingImportPreview ? (
                      <RoutingValidationNotice
                        preview={bundleRoutingImportPreview}
                        title="Routing connectivity preview"
                      />
                    ) : null}
                    <button type="button" onClick={finalizeBundleImportSetup} disabled={saving || Boolean(bundleRoutingImportPreview?.errors.length)} className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                      {saving ? 'Working...' : 'Import bundle'}
                    </button>
                  </div>
                ) : null}
              </div>
            </AdminSectionCard>
          ) : null}

          {utilityView === 'coverage' ? (
            <div className="space-y-5">
              <AdminSectionCard
                title="Routing coverage"
                description="Compare the live locations and routing datasets to spot places with missing entrance mappings or no usable path access."
              >
                {!coverageReport ? (
                  <AdminEmptyState
                    title="Coverage data is not ready"
                    message="Load both the live locations and routing datasets first. The coverage report needs both datasets in memory to compare buildings against the current routing graph."
                  />
                ) : coverageReport.isEmptyGraph ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone="info">Routing dataset empty</AdminStatusBadge>
                      <AdminStatusBadge>{coverageReport.polygonLocationCount} polygon location{coverageReport.polygonLocationCount === 1 ? '' : 's'} loaded</AdminStatusBadge>
                    </div>
                    <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700">Direct-routing fallback active</p>
                      <p className="mt-2 text-sm leading-6 text-sky-900">
                        No live walkway routes are currently published. Users will fall back to direct routing until routing features are added again, so coverage breakdowns are paused for now.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
                      <AdminStatCard
                        label="Polygon locations checked"
                        value={coverageReport.polygonLocationCount}
                        hint="Only polygon and multipolygon locations are included in v1."
                      />
                      <AdminStatCard
                        label="No explicit entrance"
                        value={coverageReport.noExplicitEntrance.length}
                        hint="Locations with zero location_id-mapped entrance nodes."
                        tone={coverageReport.noExplicitEntrance.length > 0 ? 'warning' : 'success'}
                      />
                      <AdminStatCard
                        label="Inferred only"
                        value={coverageReport.inferredOnly.length}
                        hint="Usable after inference, but still missing explicit entrance mapping."
                        tone={coverageReport.inferredOnly.length > 0 ? 'info' : 'success'}
                      />
                      <AdminStatCard
                        label="No routable access"
                        value={coverageReport.noRoutableAccess.length}
                        hint="Locations that still have no connected entrance node."
                        tone={coverageReport.noRoutableAccess.length > 0 ? 'danger' : 'success'}
                      />
                      <AdminStatCard
                        label="Indoor access missing"
                        value={coverageReport.indoorAccessMissing.length}
                        hint="Locations where runtime routing still relies on inferred or nearby access fallback."
                        tone={coverageReport.indoorAccessMissing.length > 0 ? 'warning' : 'success'}
                      />
                      <AdminStatCard
                        label="Heuristic access only"
                        value={coverageReport.heuristicOnly.length}
                        hint="Locations currently routable only through nearby graph-node fallback."
                        tone={coverageReport.heuristicOnly.length > 0 ? 'info' : 'success'}
                      />
                      <AdminStatCard
                        label="Entrance node issues"
                        value={coverageReport.combinedRoutingIssueCount}
                        hint="Unique unmapped or disconnected entrance nodes."
                        tone={coverageReport.combinedRoutingIssueCount > 0 ? 'warning' : 'success'}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone={coverageReport.partialGraph ? 'warning' : 'success'}>
                        {coverageReport.partialGraph ? 'Partial graph' : 'Graph usable'}
                      </AdminStatusBadge>
                      {coverageReport.graphWarnings.length > 0 ? (
                        <AdminStatusBadge tone="info">
                          {coverageReport.graphWarnings.length} validation warning{coverageReport.graphWarnings.length === 1 ? '' : 's'}
                        </AdminStatusBadge>
                      ) : null}
                      {coverageReport.graphErrors.length > 0 ? (
                        <AdminStatusBadge tone="danger">
                          {coverageReport.graphErrors.length} graph error{coverageReport.graphErrors.length === 1 ? '' : 's'}
                        </AdminStatusBadge>
                      ) : null}
                    </div>

                    {coverageReport.partialGraph ? (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Counts may be incomplete</p>
                        <p className="mt-2 text-sm leading-6 text-amber-900">
                          Blocking routing graph errors still exist. This report is based on the partial graph that could be built from the current routing dataset, so some counts may change after those errors are fixed.
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </AdminSectionCard>

              {coverageReport ? (
                <>
                  {!coverageReport.isEmptyGraph ? (
                    <div className="grid gap-5 xl:grid-cols-2">
                      <AdminSectionCard
                        title="Data quality gaps"
                        description="These issues usually mean the routing data still needs clearer building-to-entrance mapping."
                      >
                        <div className="space-y-5">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">No explicit entrance mapping</p>
                            <AdminStatusBadge tone={coverageReport.noExplicitEntrance.length > 0 ? 'warning' : 'success'}>
                              {coverageReport.noExplicitEntrance.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Polygon locations with zero explicit <code>location_id</code>-mapped entrance nodes.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.noExplicitEntrance.length === 0 ? (
                              <AdminEmptyState
                                title="No missing explicit entrances"
                                message="Every polygon location currently has at least one explicit entrance mapping."
                              />
                            ) : (
                              coverageReport.noExplicitEntrance.map((issue) => (
                                <article key={`no-explicit-${issue.locationId}`} className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        {getLocationAssociationDisplayCode(issue.feature) ? (
                                          <AdminStatusBadge>{getLocationAssociationDisplayCode(issue.feature)}</AdminStatusBadge>
                                        ) : null}
                                        <AdminStatusBadge tone="warning">Missing explicit entrance</AdminStatusBadge>
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{featureTitle(issue.feature)}</p>
                                      <p className="mt-1 text-xs text-slate-500">{issue.locationId}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">
                                        No explicit entrance node is mapped to this location. Connected entrances after inference: {issue.effectiveConnectedEntranceIds.length}.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openCoverageFeature('locations', issue.feature)}
                                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                                      >
                                        Open location
                                      </button>
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700 transition hover:border-sky-300 hover:bg-sky-100"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">Inferred only</p>
                            <AdminStatusBadge tone={coverageReport.inferredOnly.length > 0 ? 'info' : 'success'}>
                              {coverageReport.inferredOnly.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Locations that are usable after inferred-entrance fallback, but still missing explicit routing linkage.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.inferredOnly.length === 0 ? (
                              <AdminEmptyState
                                title="No inferred-only coverage"
                                message="There are no polygon locations currently relying only on inferred entrances."
                              />
                            ) : (
                              coverageReport.inferredOnly.map((issue) => (
                                <article key={`inferred-${issue.locationId}`} className="rounded-[24px] border border-sky-200 bg-sky-50/60 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <AdminStatusBadge tone="info">Inferred coverage</AdminStatusBadge>
                                        <AdminStatusBadge>{issue.effectiveConnectedEntranceIds.length} connected entrance{issue.effectiveConnectedEntranceIds.length === 1 ? '' : 's'}</AdminStatusBadge>
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{featureTitle(issue.feature)}</p>
                                      <p className="mt-1 text-xs text-slate-500">{issue.locationId}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">
                                        Routing can still work here, but only because a nearby entrance-like node was inferred at runtime. Add an explicit mapped entrance to make the data complete.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openCoverageFeature('locations', issue.feature)}
                                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                                      >
                                        Open location
                                      </button>
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-sky-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700 transition hover:border-sky-300 hover:bg-sky-50"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">Entrance nodes missing location_id</p>
                            <AdminStatusBadge tone={coverageReport.unmappedEntranceIssues.length > 0 ? 'warning' : 'success'}>
                              {coverageReport.unmappedEntranceIssues.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Entrance nodes that exist in routing data but are not linked to any location feature.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.unmappedEntranceIssues.length === 0 ? (
                              <AdminEmptyState
                                title="No unmapped entrance nodes"
                                message="Every entrance node currently has a location_id mapping."
                              />
                            ) : (
                              coverageReport.unmappedEntranceIssues.map((issue) => (
                                <article key={issue.key} className="rounded-[24px] border border-amber-200 bg-amber-50/60 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <AdminStatusBadge tone="warning">Missing location_id</AdminStatusBadge>
                                        <AdminStatusBadge>{issue.nodeId}</AdminStatusBadge>
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{issue.title}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">{issue.description}</p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-sky-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700 transition hover:border-sky-300 hover:bg-sky-50"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>
                        </div>
                      </AdminSectionCard>

                      <AdminSectionCard
                        title="Routing access gaps"
                        description="These issues affect whether a user can actually route into a location with the current graph."
                      >
                        <div className="space-y-5">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">Indoor access missing</p>
                            <AdminStatusBadge tone={coverageReport.indoorAccessMissing.length > 0 ? 'warning' : 'success'}>
                              {coverageReport.indoorAccessMissing.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Locations where users may still see routing start or end outside the building because no explicit connected entrance path exists yet.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.indoorAccessMissing.length === 0 ? (
                              <AdminEmptyState
                                title="No indoor-access fallback issues"
                                message="Every checked location with routing access currently has an explicit connected entrance path."
                              />
                            ) : (
                              coverageReport.indoorAccessMissing.map((issue) => (
                                <article key={`indoor-access-${issue.locationId}`} className="rounded-[24px] border border-amber-200 bg-amber-50/60 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <AdminStatusBadge tone="warning">Indoor access missing</AdminStatusBadge>
                                        {issue.explicitConnectedEntranceIds.length > 0 ? (
                                          <AdminStatusBadge>{issue.explicitConnectedEntranceIds.length} explicit connected entrance{issue.explicitConnectedEntranceIds.length === 1 ? '' : 's'}</AdminStatusBadge>
                                        ) : issue.effectiveConnectedEntranceIds.length > 0 ? (
                                          <AdminStatusBadge tone="info">Inferred entrance fallback</AdminStatusBadge>
                                        ) : (
                                          <AdminStatusBadge tone="info">Nearby reachable node fallback</AdminStatusBadge>
                                        )}
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{featureTitle(issue.feature)}</p>
                                      <p className="mt-1 text-xs text-slate-500">{issue.locationId}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">
                                        Add a connected explicit entrance so live routing can end at a legal access point instead of relying on fallback behavior.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openCoverageFeature('locations', issue.feature)}
                                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                                      >
                                        Open location
                                      </button>
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-amber-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-700 transition hover:border-amber-300 hover:bg-amber-50"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">Heuristic access only</p>
                            <AdminStatusBadge tone={coverageReport.heuristicOnly.length > 0 ? 'info' : 'success'}>
                              {coverageReport.heuristicOnly.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Locations that do not have a connected entrance node, but can still be reached through nearby connected graph nodes.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.heuristicOnly.length === 0 ? (
                              <AdminEmptyState
                                title="No heuristic-access-only locations"
                                message="Every checked location either has connected entrance coverage or no fallback access at all."
                              />
                            ) : (
                              coverageReport.heuristicOnly.map((issue) => (
                                <article key={`heuristic-${issue.locationId}`} className="rounded-[24px] border border-cyan-200 bg-cyan-50/60 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <AdminStatusBadge tone="info">Heuristic fallback</AdminStatusBadge>
                                        <AdminStatusBadge>{issue.heuristicConnectedNodeIds.length} nearby node{issue.heuristicConnectedNodeIds.length === 1 ? '' : 's'}</AdminStatusBadge>
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{featureTitle(issue.feature)}</p>
                                      <p className="mt-1 text-xs text-slate-500">{issue.locationId}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">
                                        Routing can currently reach this location only by snapping to nearby connected graph nodes. Add a connected entrance to remove the fallback dependency.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openCoverageFeature('locations', issue.feature)}
                                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                                      >
                                        Open location
                                      </button>
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-cyan-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-700 transition hover:border-cyan-300 hover:bg-cyan-50"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">No routable access</p>
                            <AdminStatusBadge tone={coverageReport.noRoutableAccess.length > 0 ? 'danger' : 'success'}>
                              {coverageReport.noRoutableAccess.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Locations that still have no connected entrance node after explicit mappings and inferred-entrance fallback are both considered.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.noRoutableAccess.length === 0 ? (
                              <AdminEmptyState
                                title="All checked locations have access"
                                message="Every polygon location currently has at least one connected entrance node."
                              />
                            ) : (
                              coverageReport.noRoutableAccess.map((issue) => (
                                <article key={`no-access-${issue.locationId}`} className="rounded-[24px] border border-rose-200 bg-rose-50/60 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <AdminStatusBadge tone="danger">No routable access</AdminStatusBadge>
                                        {issue.explicitEntranceIds.length > 0 ? (
                                          <AdminStatusBadge>{issue.explicitEntranceIds.length} explicit entrance{issue.explicitEntranceIds.length === 1 ? '' : 's'}</AdminStatusBadge>
                                        ) : null}
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{featureTitle(issue.feature)}</p>
                                      <p className="mt-1 text-xs text-slate-500">{issue.locationId}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">
                                        {issue.explicitEntranceIds.length > 0
                                          ? 'This location has entrance nodes, but none of them currently connect to a routable path.'
                                          : 'This location has no connected entrance node, even after inferred-entrance fallback.'}
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openCoverageFeature('locations', issue.feature)}
                                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                                      >
                                        Open location
                                      </button>
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-rose-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-50"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-950">Entrance nodes not connected to a path</p>
                            <AdminStatusBadge tone={coverageReport.unreachableEntranceIssues.length > 0 ? 'warning' : 'success'}>
                              {coverageReport.unreachableEntranceIssues.length}
                            </AdminStatusBadge>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Entrance nodes that still have no graph connection after routing validation and entrance auto-connect attempts.
                          </p>
                          <div className="mt-3 space-y-3">
                            {coverageReport.unreachableEntranceIssues.length === 0 ? (
                              <AdminEmptyState
                                title="No disconnected entrance nodes"
                                message="Every entrance node currently connects to at least one path edge."
                              />
                            ) : (
                              coverageReport.unreachableEntranceIssues.map((issue) => (
                                <article key={issue.key} className="rounded-[24px] border border-amber-200 bg-amber-50/60 px-4 py-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <AdminStatusBadge tone="warning">Disconnected entrance</AdminStatusBadge>
                                        <AdminStatusBadge>{issue.nodeId}</AdminStatusBadge>
                                      </div>
                                      <p className="mt-3 text-sm font-semibold text-slate-950">{issue.title}</p>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">{issue.description}</p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      {issue.locationFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('locations', issue.locationFeature)}
                                          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
                                        >
                                          Open location
                                        </button>
                                      ) : null}
                                      {issue.routingFeature ? (
                                        <button
                                          type="button"
                                          onClick={() => openCoverageFeature('routing', issue.routingFeature)}
                                          className="rounded-full border border-sky-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700 transition hover:border-sky-300 hover:bg-sky-50"
                                        >
                                          Open routing feature
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                </article>
                              ))
                            )}
                          </div>
                        </div>
                        </div>
                      </AdminSectionCard>
                    </div>
                  ) : null}

                  <AdminSectionCard
                    title="Routing graph errors"
                    description="These are blocking structural problems in the current routing dataset."
                  >
                    {coverageReport.isEmptyGraph ? (
                      <AdminEmptyState
                        title="Routing dataset is empty"
                        message="There is no live walkway graph to validate right now. Publish routing features again to resume structural graph checks."
                      />
                    ) : coverageReport.graphErrors.length === 0 ? (
                      <AdminEmptyState
                        title="No blocking graph errors"
                        message="The current routing dataset has no duplicate ids, dangling endpoints, or other structural validation errors."
                      />
                    ) : (
                      <div className="space-y-3">
                        {coverageReport.graphErrors.map((error) => (
                          <article key={error} className="rounded-[24px] border border-rose-200 bg-rose-50/60 px-4 py-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <AdminStatusBadge tone="danger">Graph error</AdminStatusBadge>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-rose-900">{error}</p>
                          </article>
                        ))}
                      </div>
                    )}
                  </AdminSectionCard>
                </>
              ) : null}
            </div>
          ) : null}

          {utilityView === 'delete' ? (
            <div className="grid gap-5 xl:grid-cols-2">
              <AdminSectionCard title="Delete current feature" description="Delete the open live feature.">
                {draftFeature && editingSourceFeatureId ? (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                      <p className="text-sm font-semibold text-slate-950">{featureTitle(draftFeature)}</p>
                      <p className="mt-2 text-sm text-slate-600">{featureMetaSummary(datasetType, draftFeature)}</p>
                    </div>
                    <button type="button" onClick={() => { void handleDeleteFeature(); }} disabled={saving} className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60">{saving ? 'Working...' : 'Delete live feature'}</button>
                  </div>
                ) : (
                  <AdminEmptyState title="No live feature open" message="Open a live feature from Edit existing first." />
                )}
              </AdminSectionCard>
              <AdminSectionCard title="Bulk delete selected" description="Delete the selected live features.">
                {selectedCount > 0 ? (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4">
                      <p className="text-sm font-semibold text-rose-900">{selectedCount} feature(s) selected</p>
                      <p className="mt-2 text-sm text-rose-700">Bulk delete publishes immediately.</p>
                    </div>
                    <button type="button" onClick={() => { void handleBulkDelete(); }} disabled={saving} className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60">{saving ? 'Working...' : 'Delete selected'}</button>
                  </div>
                ) : (
                  <AdminEmptyState title="Nothing selected" message="Select features from the Edit existing step first." />
                )}
              </AdminSectionCard>
            </div>
          ) : null}

          {utilityView === 'raw-json' ? (
            <AdminSectionCard title="Raw JSON" description="Advanced feature editing.">
              {draftFeature ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminStatusBadge tone={draftTextError ? 'danger' : 'info'}>{draftTextError ? 'Invalid JSON' : 'Active draft'}</AdminStatusBadge>
                      <AdminStatusBadge>{featureTitle(draftFeature)}</AdminStatusBadge>
                    </div>
                    <p className="mt-3 text-sm text-slate-600">{draftTextError || 'Edit the full feature JSON here, then go back to the flow to publish.'}</p>
                  </div>
                  <textarea value={draftText} onChange={handleDraftTextChange} spellCheck={false} className="min-h-[380px] w-full rounded-[24px] border border-slate-200 bg-slate-950 px-4 py-4 font-mono text-sm text-slate-100 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100" />
                </div>
              ) : (
                <AdminEmptyState title="No active draft" message="Open or create a feature first." />
              )}
            </AdminSectionCard>
          ) : null}

          {utilityView === 'history' ? (
            <AdminSectionCard title="Revision history" description="Restore a previous live publish.">
              {loading && revisions.length === 0 ? (
                <PanelSkeleton
                  title="Loading revision history"
                  subtitle="Fetching recent publishes and restore points for this dataset."
                  lines={4}
                />
              ) : revisions.length === 0 ? (
                <AdminEmptyState title="No revisions yet" message="Published revisions will appear here." />
              ) : (
                <div className="max-h-[920px] space-y-3 overflow-y-auto pr-1">
                  {revisions.map((revision) => (
                    <article key={revision.id} className="rounded-[26px] border border-slate-200 bg-slate-50 px-4 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <AdminStatusBadge tone={revisionTone(revision.changeType)}>{revision.changeType}</AdminStatusBadge>
                        <AdminStatusBadge>{revision.featureCount} feature(s)</AdminStatusBadge>
                      </div>
                      <h4 className="mt-3 font-['Outfit'] text-lg font-semibold text-slate-950">{revision.changeSummary || 'Dataset update'}</h4>
                      <p className="mt-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Published {formatRelativeTime(revision.createdAt)}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatAbsoluteTime(revision.createdAt)}</p>
                      <p className="mt-3 text-sm leading-6 text-slate-600">{revision.actor?.email ? `Published by ${revision.actor.email}.` : 'Published without actor metadata.'}</p>
                      <button type="button" onClick={() => { void handleRestoreRevision(revision); }} disabled={saving} className="mt-4 rounded-full border border-amber-200 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-800 transition hover:border-amber-300 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60">Restore this revision</button>
                    </article>
                  ))}
                </div>
              )}
            </AdminSectionCard>
          ) : null}
          {intent ? (
            <UtilityFooter
              stepLabel={`${activeUtilityLabel} / ${formatDatasetLabel(datasetType)}`}
              onBackToFlow={() => setViewMode('wizard')}
            />
          ) : null}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        className="hidden"
        onChange={(event) => {
          void handleUploadFile(event);
        }}
      />

      <ConfirmationModal
        open={Boolean(pendingTransition?.open)}
        title={pendingTransition?.title ?? ''}
        message={pendingTransition?.message ?? ''}
        confirmLabel={pendingTransition?.confirmLabel ?? 'Continue'}
        onCancel={() => setPendingTransition(null)}
        onConfirm={() => {
          if (!pendingTransition) {
            return;
          }
          applyTransition(pendingTransition.action);
          setPendingTransition(null);
        }}
      />
      <ConfirmationModal
        open={Boolean(pendingAction?.open)}
        title={pendingAction?.title ?? ''}
        message={pendingAction?.message ?? ''}
        confirmLabel={pendingAction?.confirmLabel ?? 'Continue'}
        tone={pendingAction?.tone ?? 'default'}
        busy={saving || linkedRoutingSaving}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (!pendingAction) {
            return;
          }

          if (pendingAction.action.kind === 'delete-feature') {
            void handleDeleteFeature(true);
            return;
          }

          if (pendingAction.action.kind === 'bulk-delete') {
            void handleBulkDelete(true);
            return;
          }

          if (pendingAction.action.kind === 'delete-linked-access-point') {
            void executeDeleteLinkedRoutingFeature(pendingAction.action.featureId, 'access point');
            return;
          }

          if (pendingAction.action.kind === 'delete-linked-connector') {
            void executeDeleteLinkedRoutingFeature(pendingAction.action.featureId, 'connector');
            return;
          }

          if (pendingAction.action.kind === 'import') {
            void executeBulkImport(
              pendingAction.action.collection,
              pendingAction.action.importOptions ?? null
            );
            return;
          }

          if (pendingAction.action.kind === 'import-bundle') {
            void executeBundleImport(
              pendingAction.action.bundle,
              pendingAction.action.importOptions ?? null
            );
            return;
          }

          void handleRestoreRevision(pendingAction.action.revision, true);
        }}
      />
    </div>
  );
}
