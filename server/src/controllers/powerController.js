import PowerReport from '../models/PowerReport.js';
import { logAdminActivity } from '../services/adminActivityService.js';
import { isLocationPowerUpdateLocked } from '../services/adminLocationService.js';
import { createPowerReportsForLocations } from '../services/powerOperationsService.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const resolveLimit = (value) => {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return 25;
  }

  return Math.min(Math.max(parsed, 1), 500);
};

export const reportPowerStatus = async (req, res) => {
  try {
    const locationId = toTrimmedString(req.body.locationId);
    const { powerStatus } = req.body;
    const reportedByInput = toTrimmedString(req.body.reportedBy);
    const note = toTrimmedString(req.body.note) || null;

    if (!locationId || typeof powerStatus !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'locationId and powerStatus are required',
      });
    }

    const powerUpdateLocked = await isLocationPowerUpdateLocked(locationId);
    if (powerUpdateLocked) {
      return res.status(403).json({
        success: false,
        error: 'Power updates for this location are locked to admins.',
      });
    }

    const result = await createPowerReportsForLocations({
      locationIds: [locationId],
      powerStatus,
      reportedBy: reportedByInput || req.user?.email,
      note,
      source: 'manual',
    });
    const powerReport = result.reports[0];

    await logAdminActivity({
      actionType: 'power_update',
      actionLabel: 'Power update',
      targetType: 'location',
      targetId: locationId,
      targetLabel: locationId,
      details: `Marked ${locationId} as ${powerStatus ? 'Available' : 'Unavailable'}.`,
      metadata: {
        locationId,
        powerStatus,
        note,
      },
      actor: req.user,
    });

    return res.status(201).json({
      success: true,
      data: powerReport,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to save power report',
    });
  }
};

export const getLocationPowerStatus = async (req, res) => {
  try {
    const locationId = req.params.locationId?.trim();

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required',
      });
    }

    const latestReport = await PowerReport.findOne({ locationId }).sort({ reportedAt: -1 }).lean();

    if (!latestReport) {
      return res.status(404).json({
        success: false,
        error: 'No power report found for this location',
      });
    }

    return res.status(200).json({
      success: true,
      data: latestReport,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to fetch power status',
    });
  }
};

export const getRecentPowerReports = async (req, res) => {
  try {
    const limit = resolveLimit(req.query.limit);

    const recentReports = await PowerReport.aggregate([
      {
        $sort: {
          locationId: 1,
          reportedAt: -1,
        },
      },
      {
        $group: {
          _id: '$locationId',
          latestReport: { $first: '$$ROOT' },
        },
      },
      {
        $replaceRoot: { newRoot: '$latestReport' },
      },
      {
        $sort: {
          reportedAt: -1,
        },
      },
      {
        $limit: limit,
      },
    ]);

    return res.status(200).json({
      success: true,
      data: recentReports,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to fetch recent power reports',
    });
  }
};
