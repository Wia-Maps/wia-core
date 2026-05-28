import mongoose from 'mongoose';

const { Schema } = mongoose;

const telemetryPointSchema = new Schema(
  {
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    accuracyM: {
      type: Number,
      required: true,
      min: 0,
    },
    headingDeg: {
      type: Number,
      default: null,
    },
    speedMps: {
      type: Number,
      default: null,
    },
    timestampMs: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    _id: false,
  }
);

const routeTelemetryBatchSchema = new Schema(
  {
    campusId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    deviceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      trim: true,
      default: 'web_client',
    },
    points: {
      type: [telemetryPointSchema],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'Telemetry batch must contain at least one point.',
      },
    },
    pointCount: {
      type: Number,
      required: true,
      min: 1,
    },
    startedAtMs: {
      type: Number,
      required: true,
      min: 0,
    },
    endedAtMs: {
      type: Number,
      required: true,
      min: 0,
    },
    processedAt: {
      type: Date,
      default: null,
      index: true,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    claimedBy: {
      type: String,
      default: null,
      trim: true,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    processingStatus: {
      type: String,
      enum: ['pending', 'processing', 'processed', 'discarded'],
      default: 'pending',
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: null,
    },
    ingestedAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * 30,
      index: true,
    },
  },
  {
    versionKey: false,
  }
);

routeTelemetryBatchSchema.index({ campusId: 1, sessionId: 1, ingestedAt: -1 });
routeTelemetryBatchSchema.index({ campusId: 1, deviceId: 1, ingestedAt: -1 });
routeTelemetryBatchSchema.index({ campusId: 1, processingStatus: 1, leaseExpiresAt: 1, ingestedAt: 1 });

const RouteTelemetryBatch = mongoose.model('RouteTelemetryBatch', routeTelemetryBatchSchema);

export default RouteTelemetryBatch;
