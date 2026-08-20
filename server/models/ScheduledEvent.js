import mongoose from 'mongoose';

const assignmentSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    locked: { type: Boolean, default: false },
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

const scheduledEventSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'EventTemplate', required: true },
    name: { type: String, required: true },
    durationMinutes: { type: Number, required: true, min: 1, max: 1020 },
    workersNeeded: { type: Number, required: true },
    requiredRoles: { type: [requiredRoleSchema], default: [] },
    date: { type: String, required: true, index: true },
    startMinutes: { type: Number, required: true, min: 0, max: 1440 },
    assignedWorkers: { type: [assignmentSchema], default: [] }
  },
  { timestamps: true }
);

scheduledEventSchema.index({ owner: 1, date: 1 });

export default mongoose.model('ScheduledEvent', scheduledEventSchema);
