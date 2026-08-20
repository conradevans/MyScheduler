import mongoose from 'mongoose';

const savedAssignmentSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    startMinutes: { type: Number, min: 0, max: 1440 },
    endMinutes: { type: Number, min: 0, max: 1440 }
  },
  { _id: false }
);

const requiredRoleSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, trim: true, maxlength: 60 },
    count: { type: Number, required: true, min: 1, max: 100 }
  },
  { _id: false }
);

const templateEventSchema = new mongoose.Schema(
  {
    dayOffset: { type: Number, required: true, min: 0, max: 6 },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'EventTemplate', required: true },
    name: { type: String, required: true },
    durationMinutes: { type: Number, required: true, min: 1, max: 1020 },
    workersNeeded: { type: Number, required: true, min: 1 },
    requiredRoles: { type: [requiredRoleSchema], default: [] },
    startMinutes: { type: Number, required: true, min: 0, max: 1440 },
    assignments: { type: [savedAssignmentSchema], default: [] }
  },
  { _id: false }
);

const templateShiftSchema = new mongoose.Schema(
  {
    dayOffset: { type: Number, required: true, min: 0, max: 6 },
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', default: null },
    startMinutes: { type: Number, required: true, min: 0, max: 1440 },
    endMinutes: { type: Number, required: true, min: 0, max: 1440 },
    preserveSlot: { type: Boolean, default: true }
  },
  { _id: false }
);

const scheduleTemplateSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: ['day', 'week'], required: true },
    events: { type: [templateEventSchema], default: [] },
    shifts: { type: [templateShiftSchema], default: [] }
  },
  { timestamps: true }
);

scheduleTemplateSchema.index({ owner: 1, name: 1 });

export default mongoose.model('ScheduleTemplate', scheduleTemplateSchema);
