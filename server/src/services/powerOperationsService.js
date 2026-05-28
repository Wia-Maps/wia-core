import PowerReport from '../models/PowerReport.js';
import { broadcastPowerReport } from '../realtime/powerSocket.js';
import { queuePowerStatusNotification } from './notificationQueue.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const serializePowerReport = (report) => {
  return {
    _id: report._id?.toString?.() ?? String(report._id),
    locationId: report.locationId,
    powerStatus: Boolean(report.powerStatus),
    reportedAt:
      report.reportedAt instanceof Date ? report.reportedAt.toISOString() : String(report.reportedAt),
    reportedBy: typeof report.reportedBy === 'string' ? report.reportedBy : null,
    note: typeof report.note === 'string' ? report.note : null,
    source: typeof report.source === 'string' ? report.source : null,
    scheduleId: typeof report.scheduleId === 'string' ? report.scheduleId : null,
  };
};

const buildLatestPowerReportPipeline = (locationIds) => [
  {
    $match: {
      locationId: {
        $in: locationIds,
      },
    },
  },
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
    $replaceRoot: {
      newRoot: '$latestReport',
    },
  },
];

export const getLatestPowerReportsByLocationIds = async (locationIds) => {
  const normalizedIds = [...new Set(
    (Array.isArray(locationIds) ? locationIds : [])
      .map((locationId) => toTrimmedString(locationId))
      .filter(Boolean)
  )];

  if (normalizedIds.length === 0) {
    return new Map();
  }

  const reports = await PowerReport.aggregate(buildLatestPowerReportPipeline(normalizedIds));
  return new Map(reports.map((report) => [report.locationId, serializePowerReport(report)]));
};

export const createPowerReportsForLocations = async ({
  locationIds,
  powerStatus,
  reportedBy = null,
  note = null,
  source = 'manual',
  scheduleId = null,
  reportedAt = null,
}) => {
  const normalizedIds = [...new Set(
    (Array.isArray(locationIds) ? locationIds : [])
      .map((locationId) => toTrimmedString(locationId))
      .filter(Boolean)
  )];

  if (normalizedIds.length === 0 || typeof powerStatus !== 'boolean') {
    throw new Error('locationIds and powerStatus are required.');
  }

  const previousReports = await getLatestPowerReportsByLocationIds(normalizedIds);
  const nextReportedAt = reportedAt instanceof Date ? reportedAt : new Date();
  const nextReportedBy = toTrimmedString(reportedBy) || null;
  const nextNote = toTrimmedString(note) || null;
  const nextSource = toTrimmedString(source) || 'manual';
  const nextScheduleId = toTrimmedString(scheduleId) || null;

  const insertedReports = await PowerReport.insertMany(
    normalizedIds.map((locationId) => ({
      locationId,
      powerStatus,
      reportedAt: nextReportedAt,
      reportedBy: nextReportedBy,
      note: nextNote,
      source: nextSource,
      scheduleId: nextScheduleId,
    }))
  );

  insertedReports.forEach((report) => {
    broadcastPowerReport(report);

    const previousReport = previousReports.get(report.locationId);
    if (previousReport && previousReport.powerStatus !== Boolean(report.powerStatus)) {
      void queuePowerStatusNotification({
        locationId: report.locationId,
        powerStatus: Boolean(report.powerStatus),
      }).catch((notificationError) => {
        console.error('Failed to queue power notification:', notificationError.message || notificationError);
      });
    }
  });

  return {
    reports: insertedReports.map((report) => serializePowerReport(report.toObject ? report.toObject() : report)),
    affectedCount: insertedReports.length,
    reportedAt: nextReportedAt.toISOString(),
  };
};
