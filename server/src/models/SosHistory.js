import mongoose from 'mongoose';

const sosHistorySchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [lng, lat]
      required: true
    }
  },
  accuracy: Number,
  timestamp: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24 * 7 // 7 days in seconds
  }
});

sosHistorySchema.index({ location: '2dsphere' });

export default mongoose.model('SosHistory', sosHistorySchema);
