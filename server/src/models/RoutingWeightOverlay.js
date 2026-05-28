import mongoose from 'mongoose';

const { Schema } = mongoose;

const overlayEdgeSchema = new Schema(
  {
    edgeId: {
      type: String,
      required: true,
      trim: true,
    },
    baseDistanceM: {
      type: Number,
      required: true,
      min: 0,
    },
    effectiveWeightM: {
      type: Number,
      required: true,
      min: 0,
    },
    popularityBoost: {
      type: Number,
      default: 0,
      min: 0,
    },
    congestionPenalty: {
      type: Number,
      default: 0,
      min: 0,
    },
    popularityCount7d: {
      type: Number,
      default: 0,
      min: 0,
    },
    congestionCount15m: {
      type: Number,
      default: 0,
      min: 0,
    },
    source: {
      type: String,
      default: 'analytics_worker',
      trim: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  }
);

const routingWeightOverlaySchema = new Schema(
  {
    campusId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    version: {
      type: String,
      required: true,
      trim: true,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: null,
    },
    edges: {
      type: [overlayEdgeSchema],
      default: [],
    },
    updatedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
  }
);

routingWeightOverlaySchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

const RoutingWeightOverlay = mongoose.model('RoutingWeightOverlay', routingWeightOverlaySchema);

export default RoutingWeightOverlay;
