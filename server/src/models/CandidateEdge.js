import mongoose from 'mongoose';

const { Schema } = mongoose;

const actorSchema = new Schema(
  {
    adminId: {
      type: String,
      default: null,
    },
    email: {
      type: String,
      default: null,
    },
  },
  {
    _id: false,
  }
);

const anchorSchema = new Schema(
  {
    nodeId: {
      type: String,
      default: null,
      trim: true,
    },
    locationId: {
      type: String,
      default: null,
      trim: true,
    },
    coordinates: {
      type: [Number],
      default: () => [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length === 2,
        message: 'Anchor coordinates must contain [longitude, latitude].',
      },
    },
    snapped: {
      type: Boolean,
      default: false,
    },
    distanceM: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    _id: false,
  }
);

const routePropertiesSchema = new Schema(
  {
    name: {
      type: String,
      default: '',
      trim: true,
    },
    accessible: {
      type: Boolean,
      default: true,
    },
    stairs: {
      type: Boolean,
      default: false,
    },
    ramp: {
      type: Boolean,
      default: false,
    },
    elevator: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

const candidateEdgeSchema = new Schema(
  {
    campusId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'rejected'],
      required: true,
      default: 'pending',
      index: true,
    },
    source: {
      type: String,
      enum: ['analytics_discovery', 'admin_recording'],
      required: true,
      index: true,
    },
    analyticsKey: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    geometry: {
      type: Schema.Types.Mixed,
      required: true,
    },
    startAnchor: {
      type: anchorSchema,
      required: true,
    },
    endAnchor: {
      type: anchorSchema,
      required: true,
    },
    routeProperties: {
      type: routePropertiesSchema,
      default: () => ({
        name: '',
        accessible: true,
        stairs: false,
        ramp: false,
        elevator: false,
      }),
    },
    observedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    distinctSessionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    averageDistanceM: {
      type: Number,
      default: 0,
      min: 0,
    },
    averageDurationS: {
      type: Number,
      default: 0,
      min: 0,
    },
    averageAccuracyM: {
      type: Number,
      default: 0,
      min: 0,
    },
    improvementDistanceM: {
      type: Number,
      default: 0,
    },
    telemetrySourceIds: {
      type: [String],
      default: [],
    },
    review: {
      reviewedAt: {
        type: Date,
        default: null,
      },
      reviewedBy: {
        type: actorSchema,
        default: null,
      },
      notes: {
        type: String,
        default: '',
        trim: true,
      },
      rejectionReason: {
        type: String,
        default: '',
        trim: true,
      },
    },
    publish: {
      publishedAt: {
        type: Date,
        default: null,
      },
      publishedBy: {
        type: actorSchema,
        default: null,
      },
      routingRevisionId: {
        type: String,
        default: null,
        trim: true,
      },
      featureIds: {
        type: [String],
        default: [],
      },
      overlayVersion: {
        type: String,
        default: null,
        trim: true,
      },
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

candidateEdgeSchema.index({ campusId: 1, status: 1, updatedAt: -1 });
candidateEdgeSchema.index({ campusId: 1, source: 1, updatedAt: -1 });
candidateEdgeSchema.index({ status: 1, confidence: -1, updatedAt: -1 });
candidateEdgeSchema.index(
  { analyticsKey: 1 },
  {
    unique: true,
    sparse: true,
  }
);

candidateEdgeSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

const CandidateEdge = mongoose.model('CandidateEdge', candidateEdgeSchema);

export default CandidateEdge;
