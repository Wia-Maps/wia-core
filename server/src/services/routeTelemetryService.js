import RouteTelemetryBatch from '../models/RouteTelemetryBatch.js';
import { resolveCampusId } from './routeGeometry.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizePoint = (point, index) => {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  const accuracyM = Number(point?.accuracyM ?? point?.accuracy_m);
  const headingRaw = point?.headingDeg ?? point?.heading_deg;
  const speedRaw = point?.speedMps ?? point?.speed_mps;
  const timestampMs = Number(point?.timestampMs ?? point?.timestamp_ms);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`Telemetry point ${index + 1} is missing valid coordinates.`);
  }

  if (!Number.isFinite(accuracyM) || accuracyM < 0) {
    throw new Error(`Telemetry point ${index + 1} is missing a valid accuracy.`);
  }

  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error(`Telemetry point ${index + 1} is missing a valid timestamp.`);
  }

  return {
    latitude,
    longitude,
    accuracyM,
    headingDeg: Number.isFinite(Number(headingRaw)) ? Number(headingRaw) : null,
    speedMps: Number.isFinite(Number(speedRaw)) ? Number(speedRaw) : null,
    timestampMs,
  };
};

const sortPoints = (points) => {
  return [...points].sort((left, right) => left.timestampMs - right.timestampMs);
};

export const ingestRouteTelemetryBatch = async (payload) => {
  const deviceId = toTrimmedString(payload?.deviceId);
  const sessionId = toTrimmedString(payload?.sessionId);
  const campusId = resolveCampusId(payload?.campusId ?? payload?.campus_id);
  const points = sortPoints(
    (Array.isArray(payload?.points) ? payload.points : []).map((point, index) => normalizePoint(point, index))
  );

  if (!deviceId) {
    throw new Error('deviceId is required.');
  }

  if (!sessionId) {
    throw new Error('sessionId is required.');
  }

  if (points.length === 0) {
    throw new Error('At least one telemetry point is required.');
  }

  const startedAtMs = points[0].timestampMs;
  const endedAtMs = points[points.length - 1].timestampMs;

  const record = await RouteTelemetryBatch.create({
    campusId,
    deviceId,
    sessionId,
    source: toTrimmedString(payload?.source) || 'web_client',
    points,
    pointCount: points.length,
    startedAtMs,
    endedAtMs,
    metadata: {
      campusId,
      uploadedAt: new Date().toISOString(),
    },
  });

  return {
    id: record._id?.toString?.() ?? record.id,
    campusId,
    deviceId,
    sessionId,
    pointCount: points.length,
    startedAtMs,
    endedAtMs,
    processingStatus: record.processingStatus,
    ingestedAt: new Date(record.ingestedAt).toISOString(),
  };
};
