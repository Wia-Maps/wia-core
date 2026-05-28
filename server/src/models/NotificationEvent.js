import mongoose from 'mongoose';

const notificationEventSchema = new mongoose.Schema(
  {
    locationId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    locationName: {
      type: String,
      required: true,
      trim: true,
    },
    module: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'partial_failed', 'failed'],
      default: 'queued',
      index: true,
    },
    deliveryStats: {
      totalRecipients: {
        type: Number,
        default: 0,
      },
      sent: {
        type: Number,
        default: 0,
      },
      failed: {
        type: Number,
        default: 0,
      },
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('NotificationEvent', notificationEventSchema);
