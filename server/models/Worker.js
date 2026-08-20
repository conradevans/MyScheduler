import mongoose from 'mongoose';

const recurringUnavailableSchema = new mongoose.Schema(
  {
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    allDay: { type: Boolean, default: false },
    startMinutes: { type: Number, min: 0, max: 1440 },
    endMinutes: { type: Number, min: 0, max: 1440 }
  },
  { _id: true }
);

const dateUnavailableSchema = new mongoose.Schema(
  {
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    allDay: { type: Boolean, default: true },
    startMinutes: { type: Number, min: 0, max: 1440 },
    endMinutes: { type: Number, min: 0, max: 1440 },
    reason: { type: String, trim: true, maxlength: 120, default: '' }
  },
  { _id: true }
);

const workerSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    maxWeeklyHours: { type: Number, required: true, min: 0.5, max: 168 },
    roles: { type: [String], default: [] },
    recurringUnavailable: { type: [recurringUnavailableSchema], default: [] },
    dateUnavailable: { type: [dateUnavailableSchema], default: [] }
  },
  { timestamps: true }
);

workerSchema.index({ owner: 1, name: 1 });

export default mongoose.model('Worker', workerSchema);
