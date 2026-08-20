import express from 'express';
import WorkplaceSettings from '../models/WorkplaceSettings.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

async function getOrCreate(owner) {
  let settings = await WorkplaceSettings.findOne({ owner });
  if (!settings) settings = await WorkplaceSettings.create({ owner });
  if (settings.shiftLengthHours < 3) {
    settings.shiftLengthHours = 3;
    await settings.save();
  }
  return settings;
}

router.get('/', async (req, res) => {
  const settings = await getOrCreate(req.userId);
  res.json({ settings });
});

router.put('/', async (req, res) => {
  try {
    const openMinutes = Number(req.body.openMinutes);
    const closeMinutes = Number(req.body.closeMinutes);
    const shiftLengthHours = Number(req.body.shiftLengthHours);
    const dailyHours = Array.isArray(req.body.dailyHours) ? req.body.dailyHours.map(row => ({
      dayOfWeek: Number(row.dayOfWeek),
      openMinutes: Number(row.openMinutes),
      closeMinutes: Number(row.closeMinutes)
    })) : [];
    const shiftBlocks = Array.isArray(req.body.shiftBlocks) ? req.body.shiftBlocks.map(row => ({
      dayOfWeek: Number(row.dayOfWeek),
      name: String(row.name || '').trim(),
      startMinutes: Number(row.startMinutes),
      endMinutes: Number(row.endMinutes),
      workersNeeded: Number(row.workersNeeded)
    })) : [];

    if (!Number.isInteger(openMinutes) || !Number.isInteger(closeMinutes) || openMinutes < 300 || closeMinutes > 1320 || closeMinutes <= openMinutes) {
      return res.status(400).json({ message: 'Workplace hours must fit inside the 5:00 AM–10:00 PM timetable, with closing later than opening.' });
    }
    if (!Number.isFinite(shiftLengthHours) || shiftLengthHours < 3 || shiftLengthHours > 16) {
      return res.status(400).json({ message: 'Generated shift length must be between 3 and 16 hours.' });
    }

    if (dailyHours.length !== 7 || dailyHours.some((row, index) =>
      !Number.isInteger(row.dayOfWeek) || row.dayOfWeek !== index ||
      !Number.isInteger(row.openMinutes) || !Number.isInteger(row.closeMinutes) ||
      row.openMinutes < 300 || row.closeMinutes > 1320 || row.closeMinutes <= row.openMinutes
    )) {
      return res.status(400).json({ message: 'Enter valid opening and closing hours for every day between 5:00 AM and 10:00 PM.' });
    }
    if (shiftBlocks.some(block => {
      const hours = dailyHours[block.dayOfWeek];
      return !hours || !block.name || !Number.isInteger(block.startMinutes) || !Number.isInteger(block.endMinutes) ||
        !Number.isInteger(block.workersNeeded) || block.workersNeeded < 0 || block.workersNeeded > 100 ||
        block.startMinutes < hours.openMinutes || block.endMinutes > hours.closeMinutes || block.endMinutes - block.startMinutes < 180;
    })) {
      return res.status(400).json({ message: 'Every saved shift must have a name, last at least three hours, and fit inside that day’s workplace hours.' });
    }
    const savedShiftKeys = new Set();
    if (shiftBlocks.some(block => {
      const key = `${block.dayOfWeek}:${block.startMinutes}:${block.endMinutes}`;
      if (savedShiftKeys.has(key)) return true;
      savedShiftKeys.add(key);
      return false;
    })) {
      return res.status(400).json({ message: 'Saved shifts cannot use the same start and end time on the same day. Combine them into one shift and increase its People count.' });
    }

    const settings = await WorkplaceSettings.findOneAndUpdate(
      { owner: req.userId },
      { openMinutes, closeMinutes, dailyHours, shiftBlocks, shiftLengthHours },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json({ settings });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not save workplace settings.' });
  }
});

export default router;
