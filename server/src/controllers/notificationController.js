import { isFirebaseMessagingConfigured } from '../config/firebaseAdmin.js';
import NotificationEvent from '../models/NotificationEvent.js';
import NotificationSubscription from '../models/NotificationSubscription.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeTrackedLocationIds = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(toTrimmedString).filter(Boolean))].slice(0, 50);
};

const normalizeLocationIdsQuery = (value) => {
  if (typeof value !== 'string') {
    return [];
  }

  return [...new Set(value.split(',').map(toTrimmedString).filter(Boolean))].slice(0, 50);
};

const resolveLimit = (value) => {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return 20;
  }

  return Math.min(Math.max(parsed, 1), 50);
};

export const getNotificationConfig = async (_req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      enabled: isFirebaseMessagingConfigured(),
    },
  });
};

export const getNotificationEvents = async (req, res) => {
  try {
    const locationIds = normalizeLocationIdsQuery(req.query.locationIds);
    const limit = resolveLimit(req.query.limit);

    if (locationIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    const events = await NotificationEvent.find({
      locationId: { $in: locationIds },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: events.map((event) => ({
        id: String(event._id),
        locationId: event.locationId,
        locationName: event.locationName,
        module: event.module,
        title: event.title,
        body: event.body,
        data: event.data ?? {},
        status: event.status,
        createdAt: event.createdAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to fetch notification events',
    });
  }
};

export const upsertNotificationSubscription = async (req, res) => {
  try {
    if (!isFirebaseMessagingConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Firebase messaging is not configured on the server',
      });
    }

    const fcmToken = toTrimmedString(req.body.token);

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        error: 'A valid FCM token is required',
      });
    }

    const trackedLocationIds = normalizeTrackedLocationIds(req.body.favouriteLocationIds);
    const userAgent = toTrimmedString(req.body.userAgent) || null;

    if (trackedLocationIds.length === 0) {
      await NotificationSubscription.deleteOne({ fcmToken });

      return res.status(200).json({
        success: true,
        data: {
          token: fcmToken,
          trackedLocationIds: [],
        },
      });
    }

    const record = await NotificationSubscription.findOneAndUpdate(
      { fcmToken },
      {
        fcmToken,
        trackedLocationIds,
        userAgent,
        lastSeenAt: new Date(),
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    return res.status(200).json({
      success: true,
      data: {
        token: record.fcmToken,
        trackedLocationIds: record.trackedLocationIds,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to save notification subscription',
    });
  }
};

export const deleteNotificationSubscription = async (req, res) => {
  try {
    const fcmToken = toTrimmedString(req.body.token);

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        error: 'token is required',
      });
    }

    await NotificationSubscription.deleteOne({ fcmToken });

    return res.status(200).json({
      success: true,
      data: {
        token: fcmToken,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to remove notification subscription',
    });
  }
};
