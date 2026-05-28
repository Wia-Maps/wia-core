import mongoose from 'mongoose';
import RoutingWeightOverlay from '../models/RoutingWeightOverlay.js';
import { clamp, cloneJson, resolveCampusId } from './routeGeometry.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

export const deriveEffectiveWeight = ({ distanceM, popularityBoost = 0, congestionPenalty = 0 }) => {
  const baseDistance = Math.max(1, Number(distanceM) || 1);
  const multiplier = clamp(0.75, 1 - popularityBoost + congestionPenalty, 1.5);
  return Math.max(1, Math.round(baseDistance * multiplier));
};

const serializeEdge = (entry) => ({
  edgeId: entry.edgeId,
  baseDistanceM: entry.baseDistanceM,
  effectiveWeightM: entry.effectiveWeightM,
  popularityBoost: entry.popularityBoost,
  congestionPenalty: entry.congestionPenalty,
  popularityCount7d: entry.popularityCount7d,
  congestionCount15m: entry.congestionCount15m,
  source: entry.source ?? 'analytics_worker',
  updatedAt: new Date(entry.updatedAt).toISOString(),
});

export const serializeRoutingWeightOverlay = (overlay, fallbackCampusId) => {
  if (!overlay) {
    return {
      campusId: resolveCampusId(fallbackCampusId),
      version: 'empty',
      updatedAt: new Date(0).toISOString(),
      generatedAt: new Date(0).toISOString(),
      metadata: {
        windowDays: 7,
        congestionWindowMinutes: 15,
      },
      edges: [],
    };
  }

  return {
    campusId: overlay.campusId,
    version: overlay.version,
    updatedAt: new Date(overlay.updatedAt).toISOString(),
    generatedAt: new Date(overlay.generatedAt).toISOString(),
    metadata: cloneJson(overlay.metadata ?? null),
    edges: (overlay.edges ?? []).map((entry) => serializeEdge(entry)),
  };
};

export const getRoutingWeightOverlay = async (campusIdInput) => {
  const campusId = resolveCampusId(campusIdInput);
  const overlay = await RoutingWeightOverlay.findOne({ campusId }).lean();
  return serializeRoutingWeightOverlay(overlay, campusId);
};

export const upsertRoutingWeightOverlay = async ({
  campusId: campusIdInput,
  edges,
  metadata = null,
}) => {
  const campusId = resolveCampusId(campusIdInput);
  const current = await RoutingWeightOverlay.findOne({ campusId }).lean();
  const currentEntries = new Map((current?.edges ?? []).map((entry) => [entry.edgeId, entry]));
  const normalizedEdges = [];

  (Array.isArray(edges) ? edges : []).forEach((edge) => {
    const edgeId = toTrimmedString(edge?.edgeId);
    const baseDistanceM = Math.max(1, Number(edge?.baseDistanceM) || 0);

    if (!edgeId || !baseDistanceM) {
      return;
    }

    const popularityBoost = Math.max(0, Number(edge?.popularityBoost) || 0);
    const congestionPenalty = Math.max(0, Number(edge?.congestionPenalty) || 0);
    const effectiveWeightM =
      Math.max(1, Number(edge?.effectiveWeightM) || 0) ||
      deriveEffectiveWeight({ distanceM: baseDistanceM, popularityBoost, congestionPenalty });

    currentEntries.set(edgeId, {
      edgeId,
      baseDistanceM,
      effectiveWeightM,
      popularityBoost,
      congestionPenalty,
      popularityCount7d: Math.max(0, Number(edge?.popularityCount7d) || 0),
      congestionCount15m: Math.max(0, Number(edge?.congestionCount15m) || 0),
      source: toTrimmedString(edge?.source) || 'analytics_worker',
      updatedAt: new Date(),
    });
  });

  currentEntries.forEach((entry) => {
    normalizedEdges.push(entry);
  });

  const version = new mongoose.Types.ObjectId().toString();
  const updated = await RoutingWeightOverlay.findOneAndUpdate(
    { campusId },
    {
      campusId,
      version,
      generatedAt: new Date(),
      updatedAt: new Date(),
      metadata: metadata ?? current?.metadata ?? null,
      edges: normalizedEdges,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  ).lean();

  return serializeRoutingWeightOverlay(updated, campusId);
};
