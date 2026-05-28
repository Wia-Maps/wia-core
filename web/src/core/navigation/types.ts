export type TransportMode = 'walking' | 'driving';

export type RawLocationSource = 'gps' | 'network' | 'prediction';

export interface RawLocationFix {
  lat: number;
  lng: number;
  accuracyM: number;
  altitudeM?: number | null;
  headingDeg?: number | null;
  speedMps?: number | null;
  timestampMs: number;
  source: RawLocationSource;
}

export type NavigationPoseState = 'stationary' | 'walking' | 'driving' | 'turning' | 'signal_lost';

export interface NavigationPose {
  position: [number, number];
  snappedPosition: [number, number] | null;
  rawPosition: [number, number] | null;
  headingDeg: number;
  speedMps: number;
  accelerationMps2: number;
  accuracyM: number;
  confidence: number;
  matchConfidence: number;
  sensorConfidence: number;
  predictionAgeMs: number;
  mode: TransportMode;
  state: NavigationPoseState;
  timestampMs: number;
}

export interface RouteMatch {
  edgeId: string | null;
  segmentIndex: number;
  snappedPoint: [number, number];
  distanceFromRouteM: number;
  progressDistanceM: number;
  remainingDistanceM: number;
  headingDeltaDeg: number;
  confidence: number;
}

export type RerouteStatus = 'none' | 'suspect' | 'confirming' | 'rerouting' | 'cooldown';

export interface RerouteState {
  status: RerouteStatus;
  deviationScore: number;
  offRouteSinceMs: number | null;
  lastRerouteAtMs: number | null;
}

export interface DeviceOrientationSignal {
  headingDeg: number | null;
  accuracyDeg: number | null;
  timestampMs: number;
}

export interface DeviceMotionSignal {
  rotationRateAlphaDegS: number | null;
  accelerationMps2: number | null;
  timestampMs: number;
}

export interface NavigationRuntimeSnapshot {
  pose: NavigationPose;
  sequence: number;
  rejectedFixCount: number;
  acceptedFixCount: number;
}
