import mongoose from 'mongoose';

const { Schema } = mongoose;

const mapDatasetRevisionSchema = new Schema(
  {
    datasetType: {
      type: String,
      required: true,
      enum: ['locations', 'routing'],
      index: true,
    },
    version: {
      type: String,
      required: true,
    },
    featureCount: {
      type: Number,
      required: true,
      min: 0,
    },
    collection: {
      type: Schema.Types.Mixed,
      required: true,
    },
    changeType: {
      type: String,
      required: true,
      enum: [
        'seed',
        'create_feature',
        'update_feature',
        'delete_feature',
        'bulk_upsert',
        'bulk_delete',
        'restore',
      ],
    },
    changeSummary: {
      type: String,
      required: true,
      trim: true,
    },
    actor: {
      adminId: {
        type: String,
        default: null,
      },
      email: {
        type: String,
        default: null,
      },
    },
    sourceRevisionId: {
      type: String,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

const MapDatasetRevision = mongoose.model('MapDatasetRevision', mapDatasetRevisionSchema);

export default MapDatasetRevision;
