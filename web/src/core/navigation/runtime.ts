import { clientConfig } from '../../config/client';
import { ConstantVelocityKalmanFilter } from './kalman';
import { SensorFusionEngine } from './sensorFusion';
import {
  bearingBetween,
  clamp,
  createLocalProjection,
  haversineMeters,
  normalizeHeading,
  projectAhead,
  projectToMeters,
  unprojectFromMeters,
  type LocalProjection,
} from './geo';
import type {
  DeviceMotionSignal,
  DeviceOrientationSignal,
  NavigationPose,
  NavigationRuntimeSnapshot,
  RawLocationFix,
  TransportMode,
} from './types';

type SnapshotListener = (snapshot: NavigationRuntimeSnapshot) => void;
type VisualPoseListener = (pose: NavigationPose) => void;

const RAW_FIX_BUFFER_LIMIT = 12;
const STATE_SNAPSHOT_INTERVAL_MS = 250;
const VISUAL_FRAME_MIN_MOVE_M = 0.3;
const VISUAL_FRAME_MAX_AGE_MS = 20000;

const defaultPose = (mode: TransportMode): NavigationPose => ({
  position: clientConfig.map.center,
  snappedPosition: null,
  rawPosition: null,
  headingDeg: normalizeHeading(clientConfig.map.bearing),
  speedMps: 0,
  accelerationMps2: 0,
  accuracyM: 120,
  confidence: 0,
  matchConfidence: 0,
  sensorConfidence: 0,
  predictionAgeMs: 0,
  mode,
  state: 'signal_lost',
  timestampMs: 0,
});

export class NavigationSensorRuntime {
  private mode: TransportMode;

  private projection: LocalProjection;

  private filter = new ConstantVelocityKalmanFilter();

  private fusion = new SensorFusionEngine();

  private rawFixes: RawLocationFix[] = [];

  private lastAcceptedFix: RawLocationFix | null = null;

  private lastPose: NavigationPose;

  private previousFilteredPosition: [number, number] | null = null;

  private previousSpeedMps = 0;

  private sequence = 0;

  private acceptedFixCount = 0;

  private rejectedFixCount = 0;

  private snapshotListeners = new Set<SnapshotListener>();

  private visualPoseListeners = new Set<VisualPoseListener>();

  private lastSnapshotAtMs = 0;

  private animationFrameId: number | null = null;

  private lastVisualPose: NavigationPose | null = null;

  constructor(mode: TransportMode = 'walking', origin: [number, number] = clientConfig.map.center) {
    this.mode = mode;
    this.projection = createLocalProjection(origin);
    this.lastPose = defaultPose(mode);
  }

  setMode(mode: TransportMode): void {
    this.mode = mode;
    this.lastPose = {
      ...this.lastPose,
      mode,
      state: mode === 'driving' && this.lastPose.speedMps >= 0.8 ? 'driving' : this.lastPose.state,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  subscribeVisualPose(listener: VisualPoseListener): () => void {
    this.visualPoseListeners.add(listener);
    this.ensureAnimationLoop();
    return () => {
      this.visualPoseListeners.delete(listener);
      if (this.visualPoseListeners.size === 0 && this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    };
  }

  updateOrientation(signal: DeviceOrientationSignal): void {
    this.fusion.updateOrientation(signal);
  }

  updateMotion(signal: DeviceMotionSignal): void {
    this.fusion.updateMotion(signal);
  }

  ingestFix(rawFix: RawLocationFix): NavigationPose | null {
    if (!this.isFixUsable(rawFix)) {
      this.rejectedFixCount += 1;
      return null;
    }

    const previousFix = this.lastAcceptedFix;
    if (previousFix && this.isImpossibleJump(previousFix, rawFix)) {
      this.rejectedFixCount += 1;
      return null;
    }

    const measurement = projectToMeters([rawFix.lat, rawFix.lng], this.projection);
    if (!this.filter.isInitialized()) {
      this.filter.reset(measurement);
    } else {
      const dt = clamp((rawFix.timestampMs - (previousFix?.timestampMs ?? rawFix.timestampMs)) / 1000, 0.05, 3);
      this.filter.predict(dt, this.processNoiseFor(rawFix));
    }

    this.filter.update(measurement, this.measurementNoiseFor(rawFix));

    const filteredPosition = unprojectFromMeters(this.filter.getPosition(), this.projection);
    const velocity = this.filter.getVelocity();
    const inferredSpeedMps = Math.hypot(velocity[0], velocity[1]);
    const rawSpeedMps =
      typeof rawFix.speedMps === 'number' && Number.isFinite(rawFix.speedMps) && rawFix.speedMps >= 0
        ? rawFix.speedMps
        : null;
    const speedMps = clamp(
      rawSpeedMps !== null ? rawSpeedMps * 0.6 + inferredSpeedMps * 0.4 : inferredSpeedMps,
      0,
      this.mode === 'driving' ? 45 : 3.2
    );
    const dt = previousFix
      ? clamp((rawFix.timestampMs - previousFix.timestampMs) / 1000, 0.05, 4)
      : 1;
    const accelerationMps2 = clamp((speedMps - this.previousSpeedMps) / dt, -6, 6);
    const movementBearing = this.previousFilteredPosition &&
      haversineMeters(this.previousFilteredPosition, filteredPosition) >= 0.75
        ? bearingBetween(this.previousFilteredPosition, filteredPosition)
        : null;
    const heading = this.fusion.resolveHeading({
      rawFix,
      filteredPosition,
      previousFilteredPosition: this.previousFilteredPosition,
      previousHeadingDeg: this.lastPose.headingDeg,
      speedMps,
      mode: this.mode,
      routeBearingDeg: movementBearing,
      matchConfidence: movementBearing === null ? 0 : 0.45,
    });
    const confidence = this.confidenceFor(rawFix, heading.confidence);
    const pose: NavigationPose = {
      position: filteredPosition,
      snappedPosition: null,
      rawPosition: [rawFix.lat, rawFix.lng],
      headingDeg: heading.headingDeg,
      speedMps,
      accelerationMps2,
      accuracyM: rawFix.accuracyM,
      confidence,
      matchConfidence: 0,
      sensorConfidence: heading.confidence,
      predictionAgeMs: 0,
      mode: this.mode,
      state: this.resolvePoseState(speedMps, rawFix.accuracyM),
      timestampMs: rawFix.timestampMs,
    };

    this.rawFixes = [...this.rawFixes, rawFix].slice(-RAW_FIX_BUFFER_LIMIT);
    this.previousFilteredPosition = filteredPosition;
    this.previousSpeedMps = speedMps;
    this.lastAcceptedFix = rawFix;
    this.lastPose = pose;
    this.acceptedFixCount += 1;
    this.sequence += 1;
    this.emitSnapshot(rawFix.timestampMs, false);
    return pose;
  }

  getLatestPose(nowMs = Date.now()): NavigationPose {
    if (!this.lastPose.timestampMs) {
      return this.lastPose;
    }

    const ageMs = Math.max(0, nowMs - this.lastPose.timestampMs);
    if (ageMs <= 1500) {
      return this.lastPose;
    }

    const decaySeconds = this.mode === 'driving' ? 12 : 5;
    const confidenceDecay = Math.exp(-(ageMs / 1000) / decaySeconds);
    const predictionSeconds = Math.min(ageMs / 1000, this.mode === 'driving' ? 20 : 8);
    const predictedDistanceM = this.lastPose.speedMps * confidenceDecay * predictionSeconds;
    const predictedPosition = projectAhead(this.lastPose.position, this.lastPose.headingDeg, predictedDistanceM);
    const state = ageMs > VISUAL_FRAME_MAX_AGE_MS ? 'signal_lost' : this.lastPose.state;

    return {
      ...this.lastPose,
      position: state === 'signal_lost' ? this.lastPose.position : predictedPosition,
      confidence: clamp(this.lastPose.confidence * confidenceDecay, 0, 1),
      sensorConfidence: clamp(this.lastPose.sensorConfidence * confidenceDecay, 0, 1),
      predictionAgeMs: ageMs,
      state,
      timestampMs: nowMs,
    };
  }

  clear(): void {
    this.rawFixes = [];
    this.lastAcceptedFix = null;
    this.previousFilteredPosition = null;
    this.previousSpeedMps = 0;
    this.lastPose = defaultPose(this.mode);
    this.lastVisualPose = null;
    this.sequence += 1;
    this.emitSnapshot(Date.now(), true);
  }

  private ensureAnimationLoop(): void {
    if (this.animationFrameId !== null || typeof requestAnimationFrame === 'undefined') {
      return;
    }

    const tick = (nowMs: number): void => {
      const pose = this.getLatestPose(nowMs);
      if (this.shouldEmitVisualPose(pose)) {
        this.lastVisualPose = pose;
        this.visualPoseListeners.forEach((listener) => listener(pose));
      }

      this.emitSnapshot(nowMs, false);
      this.animationFrameId = requestAnimationFrame(tick);
    };

    this.animationFrameId = requestAnimationFrame(tick);
  }

  private shouldEmitVisualPose(pose: NavigationPose): boolean {
    if (!pose.timestampMs || pose.confidence <= 0) {
      return false;
    }

    if (!this.lastVisualPose) {
      return true;
    }

    return (
      haversineMeters(this.lastVisualPose.position, pose.position) >= VISUAL_FRAME_MIN_MOVE_M ||
      Math.abs(this.lastVisualPose.headingDeg - pose.headingDeg) >= 1 ||
      Math.abs(this.lastVisualPose.confidence - pose.confidence) >= 0.08 ||
      pose.state !== this.lastVisualPose.state
    );
  }

  private emitSnapshot(nowMs: number, force: boolean): void {
    if (!force && nowMs - this.lastSnapshotAtMs < STATE_SNAPSHOT_INTERVAL_MS) {
      return;
    }

    this.lastSnapshotAtMs = nowMs;
    const snapshot: NavigationRuntimeSnapshot = {
      pose: this.getLatestPose(nowMs),
      sequence: this.sequence,
      rejectedFixCount: this.rejectedFixCount,
      acceptedFixCount: this.acceptedFixCount,
    };
    this.snapshotListeners.forEach((listener) => listener(snapshot));
  }

  private isFixUsable(rawFix: RawLocationFix): boolean {
    if (
      !Number.isFinite(rawFix.lat) ||
      !Number.isFinite(rawFix.lng) ||
      !Number.isFinite(rawFix.accuracyM) ||
      !Number.isFinite(rawFix.timestampMs)
    ) {
      return false;
    }

    if (rawFix.accuracyM > 120) {
      return false;
    }

    if (this.lastAcceptedFix && rawFix.timestampMs <= this.lastAcceptedFix.timestampMs) {
      return false;
    }

    return true;
  }

  private isImpossibleJump(previous: RawLocationFix, next: RawLocationFix): boolean {
    const dt = clamp((next.timestampMs - previous.timestampMs) / 1000, 0.05, 10);
    const distanceM = haversineMeters([previous.lat, previous.lng], [next.lat, next.lng]);
    const speed = Math.max(previous.speedMps ?? 0, next.speedMps ?? 0, this.previousSpeedMps);
    const guard = this.mode === 'driving' ? 45 : 12;
    const reachableM = speed * dt + guard + Math.max(previous.accuracyM, next.accuracyM) * 1.35;
    return distanceM > Math.max(reachableM, guard * dt);
  }

  private processNoiseFor(rawFix: RawLocationFix): number {
    const speed = rawFix.speedMps ?? this.previousSpeedMps;
    if (this.mode === 'driving') {
      return speed >= 10 ? 3.8 : 2.4;
    }

    if (speed < 0.35) {
      return 0.55;
    }

    return speed >= 1.4 ? 1.8 : 1.1;
  }

  private measurementNoiseFor(rawFix: RawLocationFix): number {
    const speed = rawFix.speedMps ?? this.previousSpeedMps;
    const stationaryBoost = speed < (this.mode === 'driving' ? 0.8 : 0.35) ? 1.8 : 1;
    return clamp(rawFix.accuracyM * stationaryBoost, 3, 160);
  }

  private confidenceFor(rawFix: RawLocationFix, sensorConfidence: number): number {
    const accuracyScore = 1 - clamp((rawFix.accuracyM - 4) / 80, 0, 1);
    return clamp(accuracyScore * 0.72 + sensorConfidence * 0.28, 0.05, 1);
  }

  private resolvePoseState(speedMps: number, accuracyM: number): NavigationPose['state'] {
    if (accuracyM > 85) {
      return 'signal_lost';
    }

    if (this.mode === 'driving' && speedMps >= 0.8) {
      return 'driving';
    }

    if (speedMps >= 0.35) {
      return 'walking';
    }

    return 'stationary';
  }
}
