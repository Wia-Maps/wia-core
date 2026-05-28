import AdminActivityLog from '../models/AdminActivityLog.js';
import { logAdminActivity } from './adminActivityService.js';
import { restoreDatasetRevision } from './mapDatasetService.js';
import { createPowerReportsForLocations } from './powerOperationsService.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const asRecord = (value) => {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};

const asStringArray = (value) => {
  return (Array.isArray(value) ? value : [])
    .map((entry) => toTrimmedString(entry))
    .filter(Boolean);
};

const resolvePowerLabel = (powerStatus) => {
  return powerStatus ? 'Available' : 'Unavailable';
};

export const revertAdminActivity = async (activityId, actor) => {
  const normalizedActivityId = toTrimmedString(activityId);
  if (!normalizedActivityId) {
    throw new Error('activityId is required.');
  }

  const activity = await AdminActivityLog.findById(normalizedActivityId).lean();
  if (!activity) {
    throw new Error(`Activity '${normalizedActivityId}' was not found.`);
  }

  const metadata = asRecord(activity.metadata);
  const datasetType = toTrimmedString(metadata?.datasetType);
  const revisionId = toTrimmedString(metadata?.revisionId);

  if (datasetType && revisionId) {
    const mutation = await restoreDatasetRevision(datasetType, revisionId, actor);

    return {
      kind: 'dataset',
      message: `Restored the ${datasetType} dataset to the selected activity state.`,
      mutation,
    };
  }

  if ((activity.actionType === 'power_update' || activity.actionType === 'power_restore') && metadata) {
    const locationId = toTrimmedString(metadata.locationId ?? activity.targetId);
    const powerStatus = metadata.powerStatus;

    if (!locationId || typeof powerStatus !== 'boolean') {
      throw new Error('This power activity is missing the data needed for restore.');
    }

    await createPowerReportsForLocations({
      locationIds: [locationId],
      powerStatus,
      reportedBy: toTrimmedString(actor?.email) || null,
      note: `Restored from activity log entry ${normalizedActivityId}.`,
      source: 'activity_restore',
    });

    await logAdminActivity({
      actionType: 'power_restore',
      actionLabel: 'Power restore',
      targetType: 'location',
      targetId: locationId,
      targetLabel: toTrimmedString(activity.targetLabel) || locationId,
      details: `Restored ${locationId} to ${resolvePowerLabel(powerStatus)} from activity log.`,
      metadata: {
        sourceActivityId: normalizedActivityId,
        locationId,
        powerStatus,
      },
      actor,
    });

    return {
      kind: 'power',
      message: `Restored power state for ${toTrimmedString(activity.targetLabel) || locationId}.`,
      affectedCount: 1,
    };
  }

  if ((activity.actionType === 'bulk_power_update' || activity.actionType === 'bulk_power_restore') && metadata) {
    const locationIds = asStringArray(metadata.locationIds);
    const locationNames = asStringArray(metadata.locationNames);
    const powerStatus = metadata.powerStatus;

    if (locationIds.length === 0 || typeof powerStatus !== 'boolean') {
      throw new Error('This bulk power activity is missing the data needed for restore.');
    }

    await createPowerReportsForLocations({
      locationIds,
      powerStatus,
      reportedBy: toTrimmedString(actor?.email) || null,
      note: `Restored from activity log entry ${normalizedActivityId}.`,
      source: 'activity_restore',
    });

    await logAdminActivity({
      actionType: 'bulk_power_restore',
      actionLabel: 'Bulk power restore',
      targetType: 'locations',
      targetId: null,
      targetLabel: `${locationIds.length} location(s)`,
      details: `Restored ${resolvePowerLabel(powerStatus)} power state for ${locationIds.length} location(s) from activity log.`,
      metadata: {
        sourceActivityId: normalizedActivityId,
        locationIds,
        locationNames,
        powerStatus,
      },
      actor,
    });

    return {
      kind: 'power',
      message: `Restored power state for ${locationIds.length} location(s).`,
      affectedCount: locationIds.length,
    };
  }

  throw new Error('This activity cannot be restored.');
};
