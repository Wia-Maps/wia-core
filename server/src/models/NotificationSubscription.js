import mongoose from 'mongoose';

const notificationSubscriptionSchema = new mongoose.Schema(
  {
    fcmToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    trackedLocationIds: {
      type: [String],
      default: [],
      index: true,
    },
    userAgent: {
      type: String,
      default: null,
      trim: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('NotificationSubscription', notificationSubscriptionSchema);
