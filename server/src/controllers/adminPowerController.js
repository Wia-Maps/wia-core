import { logAdminActivity } from '../services/adminActivityService.js';
import { listAdminLocationRows, setLocationPowerUpdateLock } from '../services/adminLocationService.js';
import { createPowerReportsForLocations } from '../services/powerOperationsService.js';
import {
  cancelPowerSchedule,
  createPowerSchedule,
  listPowerSchedules,
} from '../services/powerSchedulingService.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const resolveBulkActionLabel = (powerStatus) => {
  return powerStatus ? 'Turned ON' : 'Turned OFF';
};

const loadLocationRowsByIds = async (locationIds) => {
  const result = await listAdminLocationRows({
    page: 1,
    pageSize: 5000,
  });
  const locationMap = new Map(result.items.map((item) => [item.locationId, item]));
  return locationIds.map((locationId) => locationMap.get(locationId)).filter(Boolean);
};

export const bulkReportPowerStatus = async (req, res) => {
  try {
    const locationIds = [...new Set(
      (Array.isArray(req.body.locationIds) ? req.body.locationIds : [])
        .map((value) => toTrimmedString(value))
        .filter(Boolean)
    )];
    const { powerStatus } = req.body;
    const note = toTrimmedString(req.body.note) || null;
    const rows = await loadLocationRowsByIds(locationIds);

    if (rows.length !== locationIds.length) {
      return res.status(400).json({
        success: false,
        error: 'One or more selected locations were not found.',
      });
    }

    const result = await createPowerReportsForLocations({
      locationIds,
      powerStatus,
      reportedBy: req.user?.email,
      note,
      source: 'bulk',
    });

    await logAdminActivity({
      actionType: 'bulk_power_update',
      actionLabel: 'Bulk power update',
      targetType: 'locations',
      targetId: null,
      targetLabel: `${result.affectedCount} location(s)`,
      details: `${resolveBulkActionLabel(powerStatus)} power for ${result.affectedCount} location(s).`,
      metadata: {
        locationIds: rows.map((row) => row.locationId),
        locationNames: rows.map((row) => row.name),
        powerStatus,
        note,
      },
      actor: req.user,
    });

    return res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to save bulk power report',
    });
  }
};

export const createAdminPowerSchedule = async (req, res) => {
  try {
    const schedule = await createPowerSchedule(
      {
        locationIds: req.body.locationIds,
        action: req.body.action,
        recurrence: req.body.recurrence,
        scheduledFor: req.body.scheduledFor,
        timezone: req.body.timezone,
        note: req.body.note,
      },
      req.user
    );

    return res.status(201).json({
      success: true,
      data: schedule,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to create power schedule',
    });
  }
};

export const getAdminPowerSchedules = async (req, res) => {
  try {
    const data = await listPowerSchedules({
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: req.query.status,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to load power schedules',
    });
  }
};

export const cancelAdminPowerSchedule = async (req, res) => {
  try {
    const schedule = await cancelPowerSchedule(req.params.scheduleId, req.user);

    return res.status(200).json({
      success: true,
      data: schedule,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to cancel power schedule',
    });
  }
};

export const updateAdminPowerLocationLock = async (req, res) => {
  try {
    const result = await setLocationPowerUpdateLock(
      req.body.locationIds,
      req.body.locked,
      req.user
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to update power lock',
    });
  }
};
