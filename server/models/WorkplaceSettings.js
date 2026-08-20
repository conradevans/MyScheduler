import mongoose from 'mongoose';

const dailyHoursSchema = new mongoose.Schema({
  dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
  openMinutes: { type: Number, required: true, min: 0, max: 1439 },
  closeMinutes: { type: Number, required: true, min: 1, max: 1440 }
}, { _id: false });

const shiftBlockSchema = new mongoose.Schema({
  dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
  name: { type: String, required: true, trim: true, maxlength: 40 },
  startMinutes: { type: Number, required: true, min: 0, max: 1439 },
  endMinutes: { type: Number, required: true, min: 1, max: 1440 },
  workersNeeded: { type: Number, required: true, min: 0, max: 100, default: 1 }
}, { _id: true });

const workplaceSettingsSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    openMinutes: { type: Number, required: true, min: 0, max: 1439, default: 5 * 60 },
    closeMinutes: { type: Number, required: true, min: 1, max: 1440, default: 22 * 60 },
    dailyHours: { type: [dailyHoursSchema], default: [] },
    shiftBlocks: { type: [shiftBlockSchema], default: [] },
    shiftLengthHours: { type: Number, required: true, min: 3, max: 16, default: 4 }
  },
  { timestamps: true }
);

export default mongoose.model('WorkplaceSettings', workplaceSettingsSchema);
