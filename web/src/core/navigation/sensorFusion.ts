import { bearingBetween, clamp, haversineMeters, interpolateHeading, normalizeHeading } from './geo';
import type { DeviceMotionSignal, DeviceOrientationSignal, RawLocationFix, TransportMode } from './types';

interface HeadingCandidate {
  headingDeg: number;
  weight: number;
}

interface ResolveHeadingOptions {
  rawFix: RawLocationFix;
  filteredPosition: [number, number];
  previousFilteredPosition: [number, number] | null;
  previousHeadingDeg: number;
  speedMps: number;
  mode: TransportMode;
  routeBearingDeg?: number | null;
  matchConfidence?: number;
}

export class SensorFusionEngine {
  private orientation: DeviceOrientationSignal | null = null;

  private motion: DeviceMotionSignal | null = null;

  updateOrientation(signal: DeviceOrientationSignal): void {
    this.orientation = signal;
  }

  updateMotion(signal: DeviceMotionSignal): void {
    this.motion = signal;
  }

  resolveHeading(options: ResolveHeadingOptions): { headingDeg: number; confidence: number } {
    const {
      rawFix,
      filteredPosition,
      previousFilteredPosition,
      previousHeadingDeg,
      speedMps,
      mode,
      routeBearingDeg,
      matchConfidence = 0,
    } = options;

    const candidates: HeadingCandidate[] = [];
    const nowMs = rawFix.timestampMs;
    const movementDistanceM = previousFilteredPosition
      ? haversineMeters(previousFilteredPosition, filteredPosition)
      : 0;

    if (typeof rawFix.headingDeg === 'number' && Number.isFinite(rawFix.headingDeg) && rawFix.headingDeg >= 0) {
      const speedGate = mode === 'driving' ? 3 : 1.1;
      const accuracyPenalty = rawFix.accuracyM > 35 ? 0.45 : 1;
      candidates.push({
        headingDeg: normalizeHeading(rawFix.headingDeg),
        weight: speedMps >= speedGate ? 0.95 * accuracyPenalty : 0.28 * accuracyPenalty,
      });
    }

    if (previousFilteredPosition && movementDistanceM >= (mode === 'driving' ? 3 : 1.5)) {
      candidates.push({
        headingDeg: bearingBetween(previousFilteredPosition, filteredPosition),
        weight: clamp(movementDistanceM / (mode === 'driving' ? 12 : 5), 0.25, 0.9),
      });
    }

    if (
      typeof routeBearingDeg === 'number' &&
      Number.isFinite(routeBearingDeg) &&
      matchConfidence > 0.55
    ) {
      candidates.push({
        headingDeg: normalizeHeading(routeBearingDeg),
        weight: clamp(matchConfidence, 0.2, 0.88),
      });
    }

    if (
      this.orientation &&
      nowMs - this.orientation.timestampMs <= 1400 &&
      typeof this.orientation.headingDeg === 'number' &&
      Number.isFinite(this.orientation.headingDeg)
    ) {
      const accuracy = this.orientation.accuracyDeg ?? 45;
      const compassWeight =
        mode === 'driving'
          ? 0.12
          : speedMps < 0.35
            ? 0.28
            : clamp(1 - accuracy / 90, 0.12, 0.48);
      candidates.push({
        headingDeg: normalizeHeading(this.orientation.headingDeg),
        weight: compassWeight,
      });
    }

    if (
      this.motion &&
      nowMs - this.motion.timestampMs <= 800 &&
      typeof this.motion.rotationRateAlphaDegS === 'number' &&
      Number.isFinite(this.motion.rotationRateAlphaDegS) &&
      Math.abs(this.motion.rotationRateAlphaDegS) >= 2
    ) {
      const dt = clamp((nowMs - this.motion.timestampMs) / 1000, 0.016, 0.25);
      candidates.push({
        headingDeg: normalizeHeading(previousHeadingDeg + this.motion.rotationRateAlphaDegS * dt),
        weight: 0.16,
      });
    }

    if (candidates.length === 0) {
      return { headingDeg: normalizeHeading(previousHeadingDeg), confidence: 0.25 };
    }

    const fused = circularWeightedMean(candidates);
    const stationary = speedMps < (mode === 'driving' ? 0.8 : 0.35) && movementDistanceM < 1.2;
    const damping = stationary ? 0.08 : mode === 'driving' ? 0.42 : 0.3;
    const totalWeight = candidates.reduce((total, candidate) => total + candidate.weight, 0);

    return {
      headingDeg: interpolateHeading(previousHeadingDeg, fused, damping),
      confidence: clamp(totalWeight / 1.7, 0.1, 1),
    };
  }
}

const circularWeightedMean = (candidates: HeadingCandidate[]): number => {
  let x = 0;
  let y = 0;
  let totalWeight = 0;

  candidates.forEach((candidate) => {
    const radians = (candidate.headingDeg * Math.PI) / 180;
    x += Math.cos(radians) * candidate.weight;
    y += Math.sin(radians) * candidate.weight;
    totalWeight += candidate.weight;
  });

  if (totalWeight <= 0 || (Math.abs(x) < Number.EPSILON && Math.abs(y) < Number.EPSILON)) {
    return candidates[0]?.headingDeg ?? 0;
  }

  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
};
