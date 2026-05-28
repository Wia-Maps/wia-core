import mongoose from 'mongoose';

const powerReportSchema = new mongoose.Schema(
  {
    locationId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    powerStatus: {
      type: Boolean,
      required: true,
    },
    reportedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    reportedBy: {
      type: String,
      trim: true,
      default: null,
    },
    note: {
      type: String,
      trim: true,
      default: null,
    },
    source: {
      type: String,
      trim: true,
      default: 'manual',
    },
    scheduleId: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
  },
  {
    versionKey: false,
  }
);

powerReportSchema.index({ locationId: 1, reportedAt: -1 });

const PowerReport = mongoose.model('PowerReport', powerReportSchema);

export default PowerReport;
