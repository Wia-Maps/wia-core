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

const powerScheduleSchema = new Schema(
  {
    locationIds: {
      type: [String],
      required: true,
      default: [],
    },
    action: {
      type: String,
      required: true,
      enum: ['turn_on', 'turn_off', 'mark_unavailable'],
      index: true,
    },
    recurrence: {
      type: String,
      required: true,
      enum: ['once', 'daily', 'weekdays', 'weekly', 'monthly'],
      default: 'once',
      index: true,
    },
    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },
    timezone: {
      type: String,
      required: true,
      trim: true,
    },
    note: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['scheduled', 'executed', 'failed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    actor: {
      type: actorSchema,
      default: () => ({
        adminId: null,
        email: null,
      }),
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    executedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
      trim: true,
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

powerScheduleSchema.index({ status: 1, scheduledFor: 1, lockedAt: 1 });
powerScheduleSchema.pre('save', function handleUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

const PowerSchedule = mongoose.model('PowerSchedule', powerScheduleSchema);

export default PowerSchedule;
