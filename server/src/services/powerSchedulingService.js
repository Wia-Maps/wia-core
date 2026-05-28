import PowerSchedule from '../models/PowerSchedule.js';
import { logAdminActivity } from './adminActivityService.js';
import { listAdminLocationRows } from './adminLocationService.js';
import { createPowerReportsForLocations } from './powerOperationsService.js';

const WORKER_INTERVAL_MS = 15000;

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const toActorRecord = (actor) => ({
  adminId: toTrimmedString(actor?.adminId) || null,
  email: toTrimmedString(actor?.email) || null,
});

const scheduleActionLabels = {
  turn_on: 'Turn ON power',
  turn_off: 'Turn OFF power',
  mark_unavailable: 'Mark unavailable',
};
const recurrenceLabels = {
  once: 'One time',
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
  monthly: 'Every month',
};
const recurrenceValues = new Set(Object.keys(recurrenceLabels));

let workerHandle = null;
let workerRunning = false;

const parsePartNumber = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildDateTimeFormatter = (timeZone, options) => {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    ...options,
  });
};

const buildZonedParts = (date, timeZone) => {
  const formatter = buildDateTimeFormatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const lookup = (type) => parsePartNumber(parts.find((entry) => entry.type === type)?.value ?? '0');

  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
};

const zonedPartsToUtcMs = (parts) => {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
};

const zonedPartsToUtcDate = (parts, timeZone) => {
  let guessUtcMs = zonedPartsToUtcMs(parts);

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const currentParts = buildZonedParts(new Date(guessUtcMs), timeZone);
    const deltaMs = zonedPartsToUtcMs(parts) - zonedPartsToUtcMs(currentParts);

    if (deltaMs === 0) {
      return new Date(guessUtcMs);
    }

    guessUtcMs += deltaMs;
  }

  return new Date(guessUtcMs);
};

const addDaysToParts = (parts, days) => {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second)
  );

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
};

const daysInMonth = (year, month) => {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const addMonthsToParts = (parts, months) => {
  const totalMonths = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12 + 12) % 12 + 1;

  return {
    ...parts,
    year,
    month,
    day: Math.min(parts.day, daysInMonth(year, month)),
  };
};

const isWeekendInTimezone = (date, timeZone) => {
  const weekday = buildDateTimeFormatter(timeZone, { weekday: 'short' }).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
};

const advanceRecurringParts = (parts, recurrence) => {
  if (recurrence === 'daily') {
    return addDaysToParts(parts, 1);
  }

  if (recurrence === 'weekly') {
    return addDaysToParts(parts, 7);
  }

  if (recurrence === 'monthly') {
    return addMonthsToParts(parts, 1);
  }

  return addDaysToParts(parts, 1);
};

const getNextScheduledFor = (scheduledFor, recurrence, timeZone, referenceDate = new Date()) => {
  if (recurrence === 'once') {
    return null;
  }

  let nextParts = buildZonedParts(new Date(scheduledFor), timeZone);
  let nextDate = null;

  for (let safety = 0; safety < 400; safety += 1) {
    nextParts = advanceRecurringParts(nextParts, recurrence);
    nextDate = zonedPartsToUtcDate(nextParts, timeZone);

    if (recurrence === 'weekdays') {
      while (isWeekendInTimezone(nextDate, timeZone)) {
        nextParts = addDaysToParts(nextParts, 1);
        nextDate = zonedPartsToUtcDate(nextParts, timeZone);
      }
    }

    if (nextDate.getTime() > referenceDate.getTime()) {
      return nextDate;
    }
  }

  throw new Error('Unable to calculate the next recurring schedule time.');
};

const serializeSchedule = (schedule) => {
  const recurrence = recurrenceValues.has(schedule.recurrence) ? schedule.recurrence : 'once';

  return {
    id: schedule._id?.toString?.() ?? schedule.id,
    locationIds: Array.isArray(schedule.locationIds) ? [...schedule.locationIds] : [],
    action: schedule.action,
    actionLabel: scheduleActionLabels[schedule.action] || schedule.action,
    recurrence,
    recurrenceLabel: recurrenceLabels[recurrence] || recurrence,
    scheduledFor: new Date(schedule.scheduledFor).toISOString(),
    timezone: schedule.timezone,
    note: schedule.note ?? null,
    status: schedule.status,
    actor: schedule.actor ?? null,
    executedAt: schedule.executedAt ? new Date(schedule.executedAt).toISOString() : null,
    cancelledAt: schedule.cancelledAt ? new Date(schedule.cancelledAt).toISOString() : null,
    lastError: schedule.lastError ?? null,
    createdAt: new Date(schedule.createdAt).toISOString(),
    updatedAt: new Date(schedule.updatedAt).toISOString(),
  };
};

const resolveActionPowerStatus = (action) => {
  return action === 'turn_on';
};

const validateScheduleInput = async (locationIds, action, recurrence, scheduledFor, timezone) => {
  const normalizedIds = [...new Set(
    (Array.isArray(locationIds) ? locationIds : [])
      .map((locationId) => toTrimmedString(locationId))
      .filter(Boolean)
  )];
  const normalizedAction = toTrimmedString(action);
  const normalizedRecurrence = toTrimmedString(recurrence) || 'once';
  const normalizedTimezone = toTrimmedString(timezone);
  const nextScheduledFor = new Date(scheduledFor);

  if (normalizedIds.length === 0) {
    throw new Error('At least one location is required.');
  }

  if (!['turn_on', 'turn_off', 'mark_unavailable'].includes(normalizedAction)) {
    throw new Error('A valid schedule action is required.');
  }

  if (!recurrenceValues.has(normalizedRecurrence)) {
    throw new Error('A valid recurrence option is required.');
  }

  if (!normalizedTimezone) {
    throw new Error('timezone is required.');
  }

  if (Number.isNaN(nextScheduledFor.getTime())) {
    throw new Error('scheduledFor must be a valid date/time.');
  }

  if (nextScheduledFor.getTime() <= Date.now()) {
    throw new Error('scheduledFor must be in the future.');
  }

  const locationLookup = await listAdminLocationRows({
    page: 1,
    pageSize: 5000,
  });
  const existingIds = new Set(locationLookup.items.map((item) => item.locationId));
  const invalidIds = normalizedIds.filter((locationId) => !existingIds.has(locationId));

  if (invalidIds.length > 0) {
    throw new Error(`Unknown location ids: ${invalidIds.join(', ')}`);
  }

  return {
    locationIds: normalizedIds,
    action: normalizedAction,
    recurrence: normalizedRecurrence,
    scheduledFor: nextScheduledFor,
    timezone: normalizedTimezone,
  };
};

export const createPowerSchedule = async ({ locationIds, action, recurrence, scheduledFor, timezone, note }, actor) => {
  const validated = await validateScheduleInput(locationIds, action, recurrence, scheduledFor, timezone);

  const schedule = await PowerSchedule.create({
    locationIds: validated.locationIds,
    action: validated.action,
    recurrence: validated.recurrence,
    scheduledFor: validated.scheduledFor,
    timezone: validated.timezone,
    note: toTrimmedString(note) || null,
    status: 'scheduled',
    actor: toActorRecord(actor),
  });

  const serialized = serializeSchedule(schedule.toObject());

  await logAdminActivity({
    actionType: 'schedule_create',
    actionLabel: 'Schedule created',
    targetType: 'schedule',
    targetId: serialized.id,
    targetLabel: `${serialized.locationIds.length} location(s)`,
    details:
      serialized.recurrence === 'once'
        ? `${serialized.actionLabel} scheduled for ${serialized.scheduledFor}.`
        : `${serialized.actionLabel} scheduled for ${serialized.scheduledFor} and repeats ${serialized.recurrenceLabel.toLowerCase()}.`,
    metadata: serialized,
    actor,
  });

  return serialized;
};

export const listPowerSchedules = async ({ page = 1, pageSize = 25, status = '' } = {}) => {
  const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number.parseInt(String(pageSize), 10) || 25));
  const filter = {};
  const normalizedStatus = toTrimmedString(status);

  if (normalizedStatus) {
    filter.status = normalizedStatus;
  }

  const [items, total] = await Promise.all([
    PowerSchedule.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safePageSize)
      .limit(safePageSize)
      .lean(),
    PowerSchedule.countDocuments(filter),
  ]);

  return {
    items: items.map((item) => serializeSchedule(item)),
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
  };
};

export const cancelPowerSchedule = async (scheduleId, actor) => {
  const normalizedScheduleId = toTrimmedString(scheduleId);
  if (!normalizedScheduleId) {
    throw new Error('scheduleId is required.');
  }

  const schedule = await PowerSchedule.findOne({ _id: normalizedScheduleId });
  if (!schedule) {
    throw new Error(`Schedule '${normalizedScheduleId}' was not found.`);
  }

  if (schedule.status !== 'scheduled') {
    throw new Error('Only scheduled jobs can be cancelled.');
  }

  schedule.status = 'cancelled';
  schedule.cancelledAt = new Date();
  schedule.lockedAt = null;
  await schedule.save();

  const serialized = serializeSchedule(schedule.toObject());

  await logAdminActivity({
    actionType: 'schedule_cancel',
    actionLabel: 'Schedule cancelled',
    targetType: 'schedule',
    targetId: serialized.id,
    targetLabel: `${serialized.locationIds.length} location(s)`,
    details: `${serialized.actionLabel} schedule was cancelled.`,
    metadata: serialized,
    actor,
  });

  return serialized;
};

const claimNextDueSchedule = async () => {
  return PowerSchedule.findOneAndUpdate(
    {
      status: 'scheduled',
      lockedAt: null,
      scheduledFor: {
        $lte: new Date(),
      },
    },
    {
      $set: {
        lockedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    {
      sort: {
        scheduledFor: 1,
        _id: 1,
      },
      new: true,
    }
  );
};

const executeClaimedSchedule = async (schedule) => {
  const actor = toActorRecord(schedule.actor);

  try {
    await createPowerReportsForLocations({
      locationIds: schedule.locationIds,
      powerStatus: resolveActionPowerStatus(schedule.action),
      reportedBy: actor.email || 'scheduler',
      note: schedule.note,
      source: 'schedule',
      scheduleId: schedule._id.toString(),
    });

    const executedAt = new Date();
    const recurrence = recurrenceValues.has(schedule.recurrence) ? schedule.recurrence : 'once';
    const nextScheduledFor = getNextScheduledFor(
      schedule.scheduledFor,
      recurrence,
      schedule.timezone,
      executedAt
    );

    schedule.executedAt = executedAt;
    schedule.lockedAt = null;
    schedule.lastError = null;
    schedule.status = nextScheduledFor ? 'scheduled' : 'executed';
    if (nextScheduledFor) {
      schedule.scheduledFor = nextScheduledFor;
    }
    await schedule.save();

    const serialized = serializeSchedule(schedule.toObject());

    await logAdminActivity({
      actionType: 'schedule_execute',
      actionLabel: 'Schedule executed',
      targetType: 'schedule',
      targetId: serialized.id,
      targetLabel: `${serialized.locationIds.length} location(s)`,
      details: nextScheduledFor
        ? `${serialized.actionLabel} executed for ${serialized.locationIds.length} location(s). Next run is ${serialized.scheduledFor}.`
        : `${serialized.actionLabel} executed for ${serialized.locationIds.length} location(s).`,
      metadata: serialized,
      actor,
      createdAt: executedAt,
    });
  } catch (error) {
    schedule.status = 'failed';
    schedule.lockedAt = null;
    schedule.lastError = error.message || 'Schedule execution failed.';
    await schedule.save();

    const serialized = serializeSchedule(schedule.toObject());

    await logAdminActivity({
      actionType: 'schedule_execute',
      actionLabel: 'Schedule executed',
      targetType: 'schedule',
      targetId: serialized.id,
      targetLabel: `${serialized.locationIds.length} location(s)`,
      details: `Schedule execution failed: ${serialized.lastError}`,
      metadata: serialized,
      actor,
    });
  }
};

export const processDuePowerSchedules = async () => {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    let claimedSchedule = await claimNextDueSchedule();

    while (claimedSchedule) {
      await executeClaimedSchedule(claimedSchedule);
      claimedSchedule = await claimNextDueSchedule();
    }
  } finally {
    workerRunning = false;
  }
};

export const startPowerScheduleWorker = () => {
  if (workerHandle) {
    return workerHandle;
  }

  workerHandle = setInterval(() => {
    void processDuePowerSchedules().catch((error) => {
      console.error('Power schedule worker failed:', error.message || error);
    });
  }, WORKER_INTERVAL_MS);

  void processDuePowerSchedules().catch((error) => {
    console.error('Initial power schedule processing failed:', error.message || error);
  });

  return workerHandle;
};
