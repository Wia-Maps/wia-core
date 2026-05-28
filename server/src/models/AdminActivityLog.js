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

const adminActivityLogSchema = new Schema(
  {
    actionType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    actionLabel: {
      type: String,
      required: true,
      trim: true,
    },
    targetType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    targetId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    targetLabel: {
      type: String,
      default: null,
      trim: true,
    },
    details: {
      type: String,
      required: true,
      trim: true,
    },
    actor: {
      type: actorSchema,
      default: () => ({
        adminId: null,
        email: null,
      }),
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
  },
  {
    versionKey: false,
  }
);

adminActivityLogSchema.index({ createdAt: -1, _id: -1 });
adminActivityLogSchema.index({ actionType: 1, createdAt: -1 });

const AdminActivityLog = mongoose.model('AdminActivityLog', adminActivityLogSchema);

export default AdminActivityLog;
