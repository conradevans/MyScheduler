import express from 'express';
import Worker from '../models/Worker.js';
import ScheduledEvent from '../models/ScheduledEvent.js';
import WorkShift from '../models/WorkShift.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const workers = await Worker.find({ owner: req.userId }).sort({ name: 1 });
  res.json({ workers });
});

function cleanRoles(input) {
  const seen = new Set();
  return (Array.isArray(input) ? input : [])
    .map(value => String(value || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function sanitizeWorker(body) {
  return {
    name: String(body.name || '').trim(),
    maxWeeklyHours: Number(body.maxWeeklyHours),
    roles: cleanRoles(body.roles),
    recurringUnavailable: Array.isArray(body.recurringUnavailable) ? body.recurringUnavailable : [],
    dateUnavailable: Array.isArray(body.dateUnavailable) ? body.dateUnavailable : []
  };
}

router.post('/', async (req, res) => {
  try {
    const worker = await Worker.create({ owner: req.userId, ...sanitizeWorker(req.body) });
    res.status(201).json({ worker });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not save worker.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const worker = await Worker.findOneAndUpdate(
      { _id: req.params.id, owner: req.userId },
      sanitizeWorker(req.body),
      { new: true, runValidators: true }
    );
    if (!worker) return res.status(404).json({ message: 'Worker not found.' });
    res.json({ worker });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not update worker.' });
  }
});

router.delete('/:id', async (req, res) => {
  await ScheduledEvent.updateMany({ owner: req.userId }, { $pull: { assignedWorkers: { worker: req.params.id } } });
  await WorkShift.updateMany(
    { owner: req.userId, worker: req.params.id, preserveSlot: true },
    { $set: { worker: null, locked: true } }
  );
  await WorkShift.deleteMany({ owner: req.userId, worker: req.params.id, preserveSlot: { $ne: true } });
  const result = await Worker.deleteOne({ _id: req.params.id, owner: req.userId });
  if (!result.deletedCount) return res.status(404).json({ message: 'Worker not found.' });
  res.json({ ok: true });
});

export default router;
