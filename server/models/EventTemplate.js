import mongoose from 'mongoose';

const requiredRoleSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, trim: true, maxlength: 60 },
    count: { type: Number, required: true, min: 1, max: 100 }
  },
  { _id: false }
);

const eventTemplateSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    durationMinutes: { type: Number, required: true, min: 1, max: 1020 },
    workersNeeded: { type: Number, required: true, min: 1, max: 100 },
    requiredRoles: { type: [requiredRoleSchema], default: [] }
  },
  { timestamps: true }
);

eventTemplateSchema.index({ owner: 1, name: 1 });

export default mongoose.model('EventTemplate', eventTemplateSchema);
