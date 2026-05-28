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

const fellowshipBrandSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      default: null,
      trim: true,
    },
    contact: {
      type: String,
      default: null,
      trim: true,
    },
    logoUrl: {
      type: String,
      default: null,
      trim: true,
    },
    logoPublicId: {
      type: String,
      default: null,
      trim: true,
    },
    mimeType: {
      type: String,
      default: null,
      trim: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedBy: {
      type: actorSchema,
      default: () => ({
        adminId: null,
        email: null,
      }),
    },
  },
  {
    versionKey: false,
  }
);

fellowshipBrandSchema.index({ code: 1, updatedAt: -1 });

const FellowshipBrand = mongoose.model('FellowshipBrand', fellowshipBrandSchema);

export default FellowshipBrand;
