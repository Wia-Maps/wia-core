import {
  getCurrentDataset,
  updateFeatureInDataset,
} from './mapDatasetService.js';
import { logAdminActivity } from './adminActivityService.js';
import { syncFellowshipBrandNames } from './fellowshipBrandService.js';
import { getLatestPowerReportsByLocationIds } from './powerOperationsService.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const toBoolean = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }
  }

  return false;
};

const asRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value;
};

const toFeatureId = (feature) => {
  if (typeof feature?.id === 'string') {
    return feature.id.trim();
  }

  if (typeof feature?.id === 'number' && Number.isFinite(feature.id)) {
    return String(feature.id);
  }

  return '';
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const toFellowshipService = (value, fellowshipIndex, serviceIndex) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Fellowship entry ${fellowshipIndex + 1}, service ${serviceIndex + 1} must be an object.`
    );
  }

  const candidate = value;
  const dayLabel = toTrimmedString(candidate.dayLabel);
  const timeLabel = toTrimmedString(candidate.timeLabel);
  const roomLabel = toTrimmedString(candidate.roomLabel || candidate.venueLabel);
  const infoLabel = toTrimmedString(candidate.infoLabel);
  const hasAnyValue = Boolean(dayLabel || timeLabel || roomLabel || infoLabel);

  if (!hasAnyValue) {
    return null;
  }

  if (!dayLabel || !timeLabel) {
    throw new Error(
      `Fellowship entry ${fellowshipIndex + 1}, service ${serviceIndex + 1} must include dayLabel and timeLabel.`
    );
  }

  return {
    dayLabel,
    timeLabel,
    roomLabel: roomLabel || undefined,
    infoLabel: infoLabel || undefined,
  };
};

const toFellowshipEntry = (value, index) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Fellowship entry ${index + 1} must be an object.`);
  }

  const candidate = value;
  const code = toTrimmedString(candidate.code).toUpperCase();
  const name = toTrimmedString(candidate.name);
  const serviceCandidates = Array.isArray(candidate.services) ? candidate.services : [candidate];
  const services = serviceCandidates
    .map((service, serviceIndex) => toFellowshipService(service, index, serviceIndex))
    .filter(Boolean);
  const contact = toTrimmedString(candidate.contact);
  const hasAnyValue = Boolean(code || name || services.length > 0);

  if (!hasAnyValue) {
    return null;
  }

  if (!code || !name || services.length === 0) {
    throw new Error(
      `Fellowship entry ${index + 1} must include code, name, and at least one valid service.`
    );
  }

  return {
    code,
    name,
    contact: contact || undefined,
    services,
  };
};

const readFellowships = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => toFellowshipEntry(entry, index))
    .filter(Boolean);
};

const buildLocationSearchText = ({
  locationId,
  name,
  shortCode,
  buildingId,
  category,
  campusId,
  fellowships,
}) => {
  const fellowshipTerms = Array.isArray(fellowships)
    ? fellowships.flatMap((entry) => [
        entry.code,
        entry.name,
        entry.contact ?? '',
        ...entry.services.flatMap((service) => [
          service.dayLabel,
          service.timeLabel,
          service.roomLabel ?? '',
          service.infoLabel ?? '',
        ]),
      ])
    : [];

  return [
    locationId,
    name,
    shortCode,
    buildingId,
    category,
    campusId,
    ...fellowshipTerms,
  ]
    .filter(Boolean)
    .map((value) => toTrimmedString(value).toLowerCase())
    .join(' ');
};

const buildLocationRow = (feature, latestReport) => {
  const properties = asRecord(feature?.properties) ?? {};
  const locationId = toFeatureId(feature);
  const name = toTrimmedString(properties.name);
  const category = toTrimmedString(properties.type) || 'Location';
  const shortCode = toTrimmedString(properties.short_code) || null;
  const buildingId = shortCode || locationId;
  const campusId = toTrimmedString(properties.campus_id) || null;
  const powerUpdateLocked = toBoolean(properties.power_update_locked);
  const fellowships = readFellowships(properties.fellowships);

  if (!locationId || !name) {
    return null;
  }

  return {
    locationId,
    featureId: locationId,
    name,
    buildingId,
    shortCode,
    category,
    campusId,
    powerUpdateLocked,
    status: latestReport
      ? latestReport.powerStatus
        ? 'available'
        : 'unavailable'
      : 'no_report',
    statusLabel: latestReport
      ? latestReport.powerStatus
        ? 'Available'
        : 'Unavailable'
      : 'No report',
    lastUpdated: latestReport?.reportedAt ?? null,
    operator: latestReport?.reportedBy ?? null,
    note: latestReport?.note ?? null,
    _searchText: buildLocationSearchText({
      locationId,
      name,
      shortCode,
      buildingId,
      category,
      campusId,
      fellowships,
    }),
  };
};

const compareNullableStrings = (left, right, direction) => {
  const leftValue = toTrimmedString(left).toLowerCase();
  const rightValue = toTrimmedString(right).toLowerCase();

  if (leftValue === rightValue) {
    return 0;
  }

  if (direction === 'desc') {
    return leftValue < rightValue ? 1 : -1;
  }

  return leftValue < rightValue ? -1 : 1;
};

const compareNullableDates = (left, right, direction) => {
  const leftValue = left ? new Date(left).getTime() : 0;
  const rightValue = right ? new Date(right).getTime() : 0;

  if (leftValue === rightValue) {
    return 0;
  }

  if (direction === 'desc') {
    return leftValue < rightValue ? 1 : -1;
  }

  return leftValue < rightValue ? -1 : 1;
};

const sortRows = (rows, sortBy, sortDir) => {
  const direction = sortDir === 'desc' ? 'desc' : 'asc';
  const nextRows = [...rows];

  nextRows.sort((left, right) => {
    if (sortBy === 'buildingId') {
      return compareNullableStrings(left.buildingId, right.buildingId, direction);
    }

    if (sortBy === 'category') {
      return compareNullableStrings(left.category, right.category, direction);
    }

    if (sortBy === 'status') {
      return compareNullableStrings(left.statusLabel, right.statusLabel, direction);
    }

    if (sortBy === 'lastUpdated') {
      return compareNullableDates(left.lastUpdated, right.lastUpdated, direction);
    }

    if (sortBy === 'operator') {
      return compareNullableStrings(left.operator, right.operator, direction);
    }

    return compareNullableStrings(left.name, right.name, direction);
  });

  return nextRows;
};

const filterRows = (rows, { search = '', status = '', category = '' }) => {
  const normalizedSearch = toTrimmedString(search).toLowerCase();
  const normalizedStatus = toTrimmedString(status).toLowerCase();
  const normalizedCategory = toTrimmedString(category).toLowerCase();

  return rows.filter((row) => {
    if (normalizedStatus && row.status !== normalizedStatus) {
      return false;
    }

    if (normalizedCategory && row.category.toLowerCase() !== normalizedCategory) {
      return false;
    }

    if (!normalizedSearch) {
      return true;
    }

    const haystacks = [
      row._searchText,
      row.name,
      row.locationId,
      row.shortCode,
      row.buildingId,
      row.category,
    ]
      .filter(Boolean)
      .map((value) => toTrimmedString(value).toLowerCase());

    return haystacks.some((value) => value.includes(normalizedSearch));
  });
};

export const listAdminLocationRows = async ({
  page = 1,
  pageSize = 25,
  search = '',
  status = '',
  category = '',
  sortBy = 'name',
  sortDir = 'asc',
} = {}) => {
  const dataset = await getCurrentDataset('locations');
  const locationIds = dataset.collection.features.map((feature) => toFeatureId(feature)).filter(Boolean);
  const latestReports = await getLatestPowerReportsByLocationIds(locationIds);
  const allRows = dataset.collection.features
    .map((feature) => buildLocationRow(feature, latestReports.get(toFeatureId(feature)) ?? null))
    .filter(Boolean);

  const categories = [...new Set(allRows.map((row) => row.category))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  const filteredRows = sortRows(
    filterRows(allRows, {
      search,
      status,
      category,
    }),
    sortBy,
    sortDir
  );

  const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const safePageSize = Math.min(5000, Math.max(1, Number.parseInt(String(pageSize), 10) || 25));
  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const nextPage = Math.min(safePage, totalPages);
  const startIndex = (nextPage - 1) * safePageSize;

  return {
    items: filteredRows.slice(startIndex, startIndex + safePageSize),
    page: nextPage,
    pageSize: safePageSize,
    total,
    totalPages,
    categories,
    summary: {
      totalLocations: allRows.length,
      availableCount: allRows.filter((row) => row.status === 'available').length,
      unavailableCount: allRows.filter((row) => row.status === 'unavailable').length,
      noReportCount: allRows.filter((row) => row.status === 'no_report').length,
    },
  };
};

export const getAdminLocationDetail = async (locationId) => {
  const normalizedLocationId = toTrimmedString(locationId);
  if (!normalizedLocationId) {
    throw new Error('locationId is required.');
  }

  const dataset = await getCurrentDataset('locations');
  const feature = dataset.collection.features.find((entry) => toFeatureId(entry) === normalizedLocationId);

  if (!feature) {
    throw new Error(`Location '${normalizedLocationId}' was not found.`);
  }

  const latestReports = await getLatestPowerReportsByLocationIds([normalizedLocationId]);
  const row = buildLocationRow(feature, latestReports.get(normalizedLocationId) ?? null);
  const properties = asRecord(feature.properties) ?? {};

  return {
    location: row,
    metadata: {
      name: toTrimmedString(properties.name),
      type: toTrimmedString(properties.type),
      shortCode: toTrimmedString(properties.short_code) || '',
      campusId: toTrimmedString(properties.campus_id) || '',
      powerUpdateLocked: toBoolean(properties.power_update_locked),
      fellowships: readFellowships(properties.fellowships),
    },
  };
};

const loadLocationRowsByIds = async (locationIds) => {
  const result = await listAdminLocationRows({
    page: 1,
    pageSize: 5000,
  });
  const locationMap = new Map(result.items.map((item) => [item.locationId, item]));
  return locationIds.map((locationId) => locationMap.get(locationId)).filter(Boolean);
};

export const isLocationPowerUpdateLocked = async (locationId) => {
  const normalizedLocationId = toTrimmedString(locationId);
  if (!normalizedLocationId) {
    return false;
  }

  const dataset = await getCurrentDataset('locations');
  const feature = dataset.collection.features.find((entry) => toFeatureId(entry) === normalizedLocationId);
  const properties = asRecord(feature?.properties) ?? {};

  return toBoolean(properties.power_update_locked);
};

export const updateAdminLocationMetadata = async (locationId, input, actor) => {
  const normalizedLocationId = toTrimmedString(locationId);
  if (!normalizedLocationId) {
    throw new Error('locationId is required.');
  }

  const dataset = await getCurrentDataset('locations');
  const feature = dataset.collection.features.find((entry) => toFeatureId(entry) === normalizedLocationId);

  if (!feature) {
    throw new Error(`Location '${normalizedLocationId}' was not found.`);
  }

  const properties = asRecord(feature.properties) ?? {};
  const fellowships = readFellowships(input?.fellowships ?? properties.fellowships);
  const nextProperties = {
    ...cloneJson(properties),
    name: toTrimmedString(input?.name) || toTrimmedString(properties.name),
    type: toTrimmedString(input?.type) || toTrimmedString(properties.type) || 'Location',
    short_code: toTrimmedString(input?.shortCode) || undefined,
    campus_id: toTrimmedString(input?.campusId) || undefined,
    power_update_locked: Boolean(input?.powerUpdateLocked),
    fellowships: fellowships.length > 0 ? fellowships : undefined,
  };

  Object.keys(nextProperties).forEach((key) => {
    if (typeof nextProperties[key] === 'undefined') {
      delete nextProperties[key];
    }
  });

  const result = await updateFeatureInDataset(
    'locations',
    normalizedLocationId,
    {
      ...cloneJson(feature),
      properties: nextProperties,
    },
    actor,
    {
      skipActivityLog: true,
    }
  );

  await syncFellowshipBrandNames(fellowships, actor);

  await logAdminActivity({
    actionType: 'location_update',
    actionLabel: 'Location updated',
    targetType: 'location',
    targetId: normalizedLocationId,
    targetLabel: nextProperties.name,
    details: `Updated location metadata for '${nextProperties.name}'.`,
    metadata: {
      datasetType: 'locations',
      revisionId: result.dataset.revisionId,
      locationId: normalizedLocationId,
      fields: ['name', 'type', 'short_code', 'campus_id', 'power_update_locked', 'fellowships'],
      powerUpdateLocked: Boolean(nextProperties.power_update_locked),
      fellowshipCount: fellowships.length,
      fellowships: fellowships.map((entry) => ({
        code: entry.code,
        name: entry.name,
        contact: entry.contact ?? null,
        services: entry.services.map((service) => ({
          dayLabel: service.dayLabel,
          timeLabel: service.timeLabel,
          roomLabel: service.roomLabel ?? null,
          infoLabel: service.infoLabel ?? null,
        })),
      })),
    },
    actor,
  });

  const latestReports = await getLatestPowerReportsByLocationIds([normalizedLocationId]);
  const nextFeature = result.dataset.collection.features.find((entry) => toFeatureId(entry) === normalizedLocationId);

  return {
    location: buildLocationRow(nextFeature, latestReports.get(normalizedLocationId) ?? null),
    mutation: result,
  };
};

export const setLocationPowerUpdateLock = async (locationIds, locked, actor) => {
  const normalizedIds = [...new Set(
    (Array.isArray(locationIds) ? locationIds : [])
      .map((locationId) => toTrimmedString(locationId))
      .filter(Boolean)
  )];

  if (normalizedIds.length === 0) {
    throw new Error('At least one location is required.');
  }

  const dataset = await getCurrentDataset('locations');
  const featureMap = new Map(
    dataset.collection.features.map((feature) => [toFeatureId(feature), feature])
  );

  const missingIds = normalizedIds.filter((locationId) => !featureMap.has(locationId));
  if (missingIds.length > 0) {
    throw new Error(`Unknown location ids: ${missingIds.join(', ')}`);
  }

  for (const locationId of normalizedIds) {
    const feature = featureMap.get(locationId);
    const properties = asRecord(feature?.properties) ?? {};

    await updateFeatureInDataset(
      'locations',
      locationId,
      {
        ...cloneJson(feature),
        properties: {
          ...cloneJson(properties),
          power_update_locked: Boolean(locked),
        },
      },
      actor,
      {
        skipActivityLog: true,
      }
    );
  }

  const rows = await loadLocationRowsByIds(normalizedIds);

  await logAdminActivity({
    actionType: 'location_update',
    actionLabel: 'Location updated',
    targetType: normalizedIds.length === 1 ? 'location' : 'locations',
    targetId: normalizedIds.length === 1 ? normalizedIds[0] : null,
    targetLabel: normalizedIds.length === 1 ? rows[0]?.name ?? normalizedIds[0] : `${normalizedIds.length} location(s)`,
    details: `${locked ? 'Locked' : 'Unlocked'} public power updates for ${normalizedIds.length} location(s).`,
    metadata: {
      locationIds: rows.map((row) => row.locationId),
      locationNames: rows.map((row) => row.name),
      powerUpdateLocked: Boolean(locked),
      fields: ['power_update_locked'],
    },
    actor,
  });

  return {
    affectedCount: rows.length,
    powerUpdateLocked: Boolean(locked),
    locations: rows,
  };
};
