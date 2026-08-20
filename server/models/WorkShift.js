import mongoose from 'mongoose';

const workShiftSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', default: null, index: true },
    date: { type: String, required: true, index: true },
    startMinutes: { type: Number, required: true, min: 0, max: 1440 },
    endMinutes: { type: Number, required: true, min: 0, max: 1440 },
    locked: { type: Boolean, default: false },
    preserveSlot: { type: Boolean, default: false },
    source: { type: String, enum: ['generated', 'manual', 'template'], default: 'generated' }
  },
  { timestamps: true }
);

workShiftSchema.index({ owner: 1, date: 1, worker: 1 });

export default mongoose.model('WorkShift', workShiftSchema);
