import mongoose from 'mongoose';

const { Schema } = mongoose;

const mapDatasetSchema = new Schema(
  {
    datasetType: {
      type: String,
      required: true,
      enum: ['locations', 'routing'],
      unique: true,
      index: true,
    },
    revisionId: {
      type: String,
      required: true,
    },
    version: {
      type: String,
      required: true,
    },
    updatedAt: {
      type: Date,
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
  },
  {
    versionKey: false,
  }
);

const MapDataset = mongoose.model('MapDataset', mapDatasetSchema);

export default MapDataset;
