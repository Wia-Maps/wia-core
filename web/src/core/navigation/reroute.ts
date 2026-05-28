import { clamp } from './geo';
import type { NavigationPose, RerouteState, RouteMatch, TransportMode } from './types';

const DEFAULT_REROUTE_STATE: RerouteState = {
  status: 'none',
  deviationScore: 0,
  offRouteSinceMs: null,
  lastRerouteAtMs: null,
};

export const createRerouteState = (): RerouteState => ({ ...DEFAULT_REROUTE_STATE });

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

const thresholdFor = (mode: TransportMode, accuracyM: number): number => {
  const base = mode === 'driving' ? 28 : 10;
  return accuracyM > 35 ? base * 1.8 : base;
};

export const updateRerouteState = ({
  previousState,
  pose,
  match,
  previousProgressM,
  nowMs,
}: {
  previousState: RerouteState;
  pose: NavigationPose;
  match: RouteMatch | null;
  previousProgressM: number | null;
  nowMs: number;
}): RerouteState => {
  if (!match) {
    return {
      ...previousState,
      status: previousState.status === 'cooldown' ? 'cooldown' : 'suspect',
      deviationScore: Math.max(previousState.deviationScore, 0.7),
      offRouteSinceMs: previousState.offRouteSinceMs ?? nowMs,
    };
  }

  const routeThreshold = thresholdFor(pose.mode, pose.accuracyM);
  const distancePenalty = sigmoid((match.distanceFromRouteM - routeThreshold) / 9);
  const headingPenalty = pose.speedMps < 0.65 ? 0 : sigmoid((match.headingDeltaDeg - 95) / 22);
  const progressPenalty =
    previousProgressM !== null && match.progressDistanceM < previousProgressM - 8
      ? 0.45
      : 0;
  const jitterRelief = match.distanceFromRouteM < routeThreshold * 1.35 && match.confidence >= 0.32 ? 0.55 : 1;
  const accuracyRelief = pose.accuracyM > 35 ? 0.45 : 1;
  const deviationScore = clamp(
    (distancePenalty * 0.58 + headingPenalty * 0.27 + progressPenalty * 0.15) * accuracyRelief * jitterRelief,
    0,
    1
  );
  const recovered = deviationScore < 0.35 && match.confidence >= 0.45;

  if (previousState.status === 'cooldown') {
    if (previousState.lastRerouteAtMs && nowMs - previousState.lastRerouteAtMs < 12000) {
      return {
        ...previousState,
        deviationScore,
        offRouteSinceMs: recovered ? null : previousState.offRouteSinceMs,
      };
    }
  }

  if (recovered) {
    return {
      status: 'none',
      deviationScore,
      offRouteSinceMs: null,
      lastRerouteAtMs: previousState.lastRerouteAtMs,
    };
  }

  const offRouteSinceMs = previousState.offRouteSinceMs ?? nowMs;
  const elapsedMs = nowMs - offRouteSinceMs;
  const confirmationMs = pose.mode === 'driving' ? 4500 : pose.accuracyM > 35 ? 5500 : 3500;
  const strongDistanceDeviation = match.distanceFromRouteM >= routeThreshold * 1.7;
  const veryStrongDistanceDeviation = match.distanceFromRouteM >= routeThreshold * 2.4;
  const shouldConfirm =
    elapsedMs >= confirmationMs &&
    strongDistanceDeviation &&
    (deviationScore > 0.78 || veryStrongDistanceDeviation);
  const status = shouldConfirm
    ? 'confirming'
    : deviationScore > 0.72
      ? 'suspect'
      : 'none';

  return {
    status,
    deviationScore,
    offRouteSinceMs: status === 'none' ? null : offRouteSinceMs,
    lastRerouteAtMs: previousState.lastRerouteAtMs,
  };
};
