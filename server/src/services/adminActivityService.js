import AdminActivityLog from '../models/AdminActivityLog.js';

const ACTION_LABELS = {
  power_update: 'Power update',
  bulk_power_update: 'Bulk power update',
  dataset_publish: 'Dataset publish',
  dataset_restore: 'Dataset restore',
  schedule_create: 'Schedule created',
  schedule_execute: 'Schedule executed',
  schedule_cancel: 'Schedule cancelled',
  location_update: 'Location updated',
  fellowship_brand_upload: 'Fellowship badge uploaded',
  fellowship_brand_remove: 'Fellowship badge removed',
  route_candidate_update: 'Route candidate updated',
  route_candidate_approve: 'Route candidate approved',
  route_candidate_reject: 'Route candidate rejected',
  route_recording_draft_save: 'Route draft saved',
  route_recording_draft_delete: 'Route draft deleted',
  route_recording_submit: 'Route submitted',
  admin_route_publish: 'Admin route published',
  analytics_run_summary: 'Analytics run summary',
};

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const toActorRecord = (actor) => {
  return {
    adminId: toTrimmedString(actor?.adminId) || null,
    email: toTrimmedString(actor?.email) || null,
  };
};

const toRegex = (value) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
};

const serializeActivityLog = (entry) => {
  return {
    id: entry._id?.toString?.() ?? entry.id,
    timestamp: new Date(entry.createdAt).toISOString(),
    operator: entry.actor?.email ?? null,
    actionType: entry.actionType,
    actionLabel: entry.actionLabel,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    targetLabel: entry.targetLabel ?? null,
    details: entry.details,
    metadata: entry.metadata ?? null,
  };
};

export const logAdminActivity = async ({
  actionType,
  actionLabel,
  targetType,
  targetId = null,
  targetLabel = null,
  details,
  metadata = null,
  actor = null,
  createdAt = null,
  session = null,
}) => {
  const normalizedActionType = toTrimmedString(actionType);
  const normalizedTargetType = toTrimmedString(targetType);
  const normalizedDetails = toTrimmedString(details);

  if (!normalizedActionType || !normalizedTargetType || !normalizedDetails) {
    throw new Error('actionType, targetType, and details are required for activity logging.');
  }

  const entry = new AdminActivityLog({
    actionType: normalizedActionType,
    actionLabel: toTrimmedString(actionLabel) || ACTION_LABELS[normalizedActionType] || normalizedActionType,
    targetType: normalizedTargetType,
    targetId: toTrimmedString(targetId) || null,
    targetLabel: toTrimmedString(targetLabel) || null,
    details: normalizedDetails,
    actor: toActorRecord(actor),
    metadata,
    createdAt: createdAt instanceof Date ? createdAt : undefined,
  });

  await entry.save(session ? { session } : undefined);

  return serializeActivityLog(entry.toObject());
};

export const listAdminActivities = async ({
  page = 1,
  pageSize = 25,
  search = '',
  actionType = '',
  dateFrom = '',
  dateTo = '',
}) => {
  const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number.parseInt(String(pageSize), 10) || 25));
  const normalizedSearch = toTrimmedString(search);
  const normalizedActionType = toTrimmedString(actionType);
  const filter = {};

  if (normalizedActionType) {
    filter.actionType = normalizedActionType;
  }

  if (normalizedSearch) {
    const searchRegex = toRegex(normalizedSearch);
    filter.$or = [
      { actionLabel: searchRegex },
      { targetLabel: searchRegex },
      { targetId: searchRegex },
      { details: searchRegex },
      { 'actor.email': searchRegex },
    ];
  }

  if (dateFrom || dateTo) {
    filter.createdAt = {};

    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        filter.createdAt.$gte = fromDate;
      }
    }

    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!Number.isNaN(toDate.getTime())) {
        filter.createdAt.$lte = toDate;
      }
    }

    if (Object.keys(filter.createdAt).length === 0) {
      delete filter.createdAt;
    }
  }

  const [items, total, actionTypes] = await Promise.all([
    AdminActivityLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safePageSize)
      .limit(safePageSize)
      .lean(),
    AdminActivityLog.countDocuments(filter),
    AdminActivityLog.distinct('actionType'),
  ]);

  return {
    items: items.map((item) => serializeActivityLog(item)),
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    actionTypes: actionTypes
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .sort((left, right) => left.localeCompare(right)),
  };
};
