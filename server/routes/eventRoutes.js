import express from 'express';
import EventTemplate from '../models/EventTemplate.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const events = await EventTemplate.find({ owner: req.userId }).sort({ name: 1 });
  res.json({ events });
});

function cleanRequiredRoles(input, workersNeeded) {
  const map = new Map();
  for (const row of Array.isArray(input) ? input : []) {
    const role = String(row?.role || '').trim().replace(/\s+/g, ' ');
    const count = Number(row?.count);
    if (!role) continue;
    if (!Number.isInteger(count) || count < 1) throw new Error('Each required role must have a whole-number count of at least 1.');
    const key = role.toLowerCase();
    const current = map.get(key) || { role, count: 0 };
    current.count += count;
    map.set(key, current);
  }
  const roles = [...map.values()];
  const total = roles.reduce((sum, row) => sum + row.count, 0);
  if (total > workersNeeded) throw new Error('Required role counts cannot add up to more than the total people needed.');
  return roles;
}

router.post('/', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const durationMinutes = Number(req.body.durationMinutes);
    const workersNeeded = Number(req.body.workersNeeded);
    if (!name || !Number.isInteger(durationMinutes) || !Number.isInteger(workersNeeded)) {
      return res.status(400).json({ message: 'Name, duration in whole minutes, and workers needed are required.' });
    }
    if (durationMinutes < 1 || durationMinutes > 1020) return res.status(400).json({ message: 'Duration must be between 1 and 1020 minutes.' });
    if (workersNeeded < 1 || workersNeeded > 100) return res.status(400).json({ message: 'People needed must be between 1 and 100.' });
    const requiredRoles = cleanRequiredRoles(req.body.requiredRoles, workersNeeded);
    const event = await EventTemplate.create({ owner: req.userId, name, durationMinutes, workersNeeded, requiredRoles });
    res.status(201).json({ event });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not save event.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const update = {
      name: String(req.body.name || '').trim(),
      durationMinutes: Number(req.body.durationMinutes),
      workersNeeded: Number(req.body.workersNeeded)
    };
    if (!update.name || !Number.isInteger(update.durationMinutes) || update.durationMinutes < 1 || update.durationMinutes > 1020 || !Number.isInteger(update.workersNeeded) || update.workersNeeded < 1 || update.workersNeeded > 100) {
      return res.status(400).json({ message: 'Enter a valid name, a duration from 1 to 1020 whole minutes, and a whole-number worker count.' });
    }
    update.requiredRoles = cleanRequiredRoles(req.body.requiredRoles, update.workersNeeded);
    const event = await EventTemplate.findOneAndUpdate({ _id: req.params.id, owner: req.userId }, update, { new: true, runValidators: true });
    if (!event) return res.status(404).json({ message: 'Event not found.' });
    res.json({ event });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not update event.' });
  }
});

router.delete('/:id', async (req, res) => {
  const result = await EventTemplate.deleteOne({ _id: req.params.id, owner: req.userId });
  if (!result.deletedCount) return res.status(404).json({ message: 'Event not found.' });
  res.json({ ok: true });
});

export default router;
