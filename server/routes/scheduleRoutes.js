import express from 'express';
import ScheduledEvent from '../models/ScheduledEvent.js';
import EventTemplate from '../models/EventTemplate.js';
import Worker from '../models/Worker.js';
import WorkShift from '../models/WorkShift.js';
import WorkplaceSettings from '../models/WorkplaceSettings.js';
import { requireAuth } from '../middleware/auth.js';
import { addDays, getDayOfWeek, getWeekRange, mondayOf, SCHEDULE_END, SCHEDULE_START, rangesOverlap } from '../utils/dates.js';
import {
  calculateWorkerShiftHours,
  workerUnavailabilityConflict,
  eventOverlapConflict,
  scheduledEventOverlapConflict,
  shiftOverlapConflict,
  missingRoleSlots,
  workerHasRole,
  roleAssignmentFeasibility,
  formatMinutes
} from '../utils/scheduling.js';

const router = express.Router();
router.use(requireAuth);

async function populatedWeek(owner, weekStart) {
  const { start, end } = getWeekRange(weekStart);
  return ScheduledEvent.find({ owner, date: { $gte: start, $lte: end } })
    .populate('assignedWorkers.worker')
    .sort({ date: 1, startMinutes: 1 });
}

async function populatedShifts(owner, weekStart) {
  const { start, end } = getWeekRange(weekStart);
  return WorkShift.find({ owner, date: { $gte: start, $lte: end } })
    .populate('worker')
    .sort({ date: 1, startMinutes: 1 });
}

async function getSettings(owner) {
  let settings = await WorkplaceSettings.findOne({ owner });
  if (!settings) settings = await WorkplaceSettings.create({ owner });
  if (settings.shiftLengthHours < 3) {
    settings.shiftLengthHours = 3;
    await settings.save();
  }
  return settings;
}

function assignmentRange(assignment, event) {
  return {
    start: assignment.startMinutes ?? event.startMinutes,
    end: assignment.endMinutes ?? (event.startMinutes + event.durationMinutes)
  };
}

function shiftCovers(shifts, workerId, date, start, end) {
  return (shifts || []).some(shift =>
    String(shift.worker?._id || shift.worker) === String(workerId) &&
    shift.date === date && shift.startMinutes <= start && shift.endMinutes >= end
  );
}

function effectiveWorkerHours(workerId, shifts, events) {
  let minutes = calculateWorkerShiftHours(workerId, shifts) * 60;
  for (const event of events || []) {
    for (const assignment of event.assignedWorkers || []) {
      if (String(assignment.worker?._id || assignment.worker) !== String(workerId)) continue;
      const range = assignmentRange(assignment, event);
      if (!shiftCovers(shifts, workerId, event.date, range.start, range.end)) {
        minutes += Math.max(0, range.end - range.start);
      }
    }
  }
  return minutes / 60;
}

function coverageStatus(event) {
  const eventStart = event.startMinutes;
  const eventEnd = event.startMinutes + event.durationMinutes;
  const boundaries = new Set([eventStart, eventEnd]);
  for (const assignment of event.assignedWorkers || []) {
    const range = assignmentRange(assignment, event);
    boundaries.add(Math.max(eventStart, range.start));
    boundaries.add(Math.min(eventEnd, range.end));
  }
  const points = [...boundaries].filter(n => n >= eventStart && n <= eventEnd).sort((a, b) => a - b);
  let minCount = Infinity;
  let fullyStaffed = true;
  let rolesCovered = true;
  const missingRoles = new Set();

  if (points.length < 2) points.push(eventEnd);
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const active = (event.assignedWorkers || []).filter(assignment => {
      const range = assignmentRange(assignment, event);
      return range.start <= start && range.end >= end && assignment.worker;
    });
    minCount = Math.min(minCount, active.length);
    if (active.length < event.workersNeeded) fullyStaffed = false;
    const workers = active.map(a => a.worker).filter(Boolean);
    const missing = missingRoleSlots(workers, event.requiredRoles || []);
    if (missing.length) {
      rolesCovered = false;
      missing.forEach(role => missingRoles.add(role));
    }
  }

  if (minCount === Infinity) minCount = 0;
  return {
    fullyStaffed: fullyStaffed && rolesCovered,
    minimumWorkersPresent: minCount,
    rolesCovered,
    missingRoles: [...missingRoles]
  };
}

function eventJson(event) {
  const object = event.toObject ? event.toObject() : event;
  return { ...object, coverage: coverageStatus(event) };
}

function fullShiftLengthMinutes(settings) {
  return Math.max(180, Math.round((Number(settings?.shiftLengthHours) || 4) * 60));
}

function workHoursForDate(settings, date) {
  const day = (settings.dailyHours || []).find(row => row.dayOfWeek === getDayOfWeek(date));
  return {
    openMinutes: Number(day?.openMinutes ?? settings.openMinutes),
    closeMinutes: Number(day?.closeMinutes ?? settings.closeMinutes)
  };
}

function generatedShiftStarts(settings, date) {
  const length = fullShiftLengthMinutes(settings);
  const { openMinutes: open, closeMinutes: close } = workHoursForDate(settings, date);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close - open < length) return [];
  const starts = [];
  for (let start = open; start + length <= close; start += 60) starts.push(start);
  const latest = close - length;
  if (latest >= open && !starts.includes(latest)) starts.push(latest);
  return starts.sort((a, b) => a - b);
}

function fullShiftWindowsCovering(settings, date, coverStart, coverEnd) {
  const length = fullShiftLengthMinutes(settings);
  return generatedShiftStarts(settings, date)
    .filter(start => start <= coverStart && start + length >= coverEnd)
    .map(start => ({ startMinutes: start, endMinutes: start + length }))
    // Prefer the latest possible start: it avoids unnecessary early staffing and
    // keeps the worker available later in the day.
    .sort((a, b) => b.startMinutes - a.startMinutes);
}

// Generated shifts use the configured length as a target. A one-hour adjustment
// in either direction lets the last handoff land on closing time instead of
// bringing in another full batch that overlaps the outgoing workers.
function flexibleShiftWindowsCovering(settings, date, coverStart, coverEnd) {
  const target = fullShiftLengthMinutes(settings);
  const { openMinutes: open, closeMinutes: close } = workHoursForDate(settings, date);
  const minimum = 180;
  const maximum = Math.max(target + 120, close - open);
  const windows = [];

  function add(startMinutes, endMinutes) {
    const duration = endMinutes - startMinutes;
    if (startMinutes < open || endMinutes > close || duration < minimum || duration > maximum) return;
    if (startMinutes > coverStart || endMinutes < coverEnd) return;
    const key = `${startMinutes}-${endMinutes}`;
    if (!windows.some(window => window.key === key)) windows.push({ key, startMinutes, endMinutes });
  }

  const remaining = close - coverStart;
  if (remaining >= minimum && remaining <= maximum) add(coverStart, close);
  add(coverStart, Math.min(close, coverStart + target));
  add(coverStart, Math.min(close, coverStart + minimum));
  add(Math.max(open, coverEnd - target), Math.max(open, coverEnd - target) + target);
  fullShiftWindowsCovering(settings, date, coverStart, coverEnd).forEach(window => add(window.startMinutes, window.endMinutes));

  return windows
    .map(({ key, ...window }) => window)
    .sort((a, b) => {
      const aStartsAtHandoff = a.startMinutes === coverStart ? 0 : 1;
      const bStartsAtHandoff = b.startMinutes === coverStart ? 0 : 1;
      if (aStartsAtHandoff !== bStartsAtHandoff) return aStartsAtHandoff - bStartsAtHandoff;
      const aLeavesShortTail = close - a.endMinutes > 0 && close - a.endMinutes < minimum ? 1 : 0;
      const bLeavesShortTail = close - b.endMinutes > 0 && close - b.endMinutes < minimum ? 1 : 0;
      if (aLeavesShortTail !== bLeavesShortTail) return aLeavesShortTail - bLeavesShortTail;
      const aDeviation = Math.abs((a.endMinutes - a.startMinutes) - target);
      const bDeviation = Math.abs((b.endMinutes - b.startMinutes) - target);
      return aDeviation - bDeviation || b.startMinutes - a.startMinutes;
    });
}

function shiftsForWorkerOnDate(shifts, workerId, date) {
  return (shifts || []).filter(shift =>
    String(shift.worker?._id || shift.worker) === String(workerId) && shift.date === date
  );
}

function workerCanTakeFullShift(worker, date, window, shifts, currentHours) {
  // MyScheduler deliberately forbids split shifts. A worker gets at most one
  // continuous workplace shift on a given day.
  if (shiftsForWorkerOnDate(shifts, worker._id, date).length) return false;
  const unavailable = workerUnavailabilityConflict(worker, {
    date,
    startMinutes: window.startMinutes,
    endMinutes: window.endMinutes
  });
  if (unavailable) return false;
  const hours = (window.endMinutes - window.startMinutes) / 60;
  return (currentHours.get(String(worker._id)) || 0) + hours <= worker.maxWeeklyHours + 1e-9;
}

function bestFullShiftWindow(worker, date, coverStart, coverEnd, settings, shifts, currentHours) {
  return flexibleShiftWindowsCovering(settings, date, coverStart, coverEnd)
    .find(window => workerCanTakeFullShift(worker, date, window, shifts, currentHours)) || null;
}


async function cleanupManualShiftIfUnused(owner, workerId, date, ignoreEventId = null) {
  const query = { owner, date };
  if (ignoreEventId) query._id = { $ne: ignoreEventId };
  const dayEvents = await ScheduledEvent.find(query);
  const stillUsed = dayEvents.some(event => (event.assignedWorkers || []).some(assignment =>
    String(assignment.worker?._id || assignment.worker) === String(workerId)
  ));
  if (!stillUsed) {
    await WorkShift.deleteMany({ owner, worker: workerId, date, source: 'manual', preserveSlot: { $ne: true } });
    // A generated shift can become locked when the user manually assigns the
    // worker to an event inside it. If that manual use disappears, let future
    // generations rebalance the shift again.
    await WorkShift.updateMany(
      { owner, worker: workerId, date, source: 'generated', locked: true },
      { $set: { locked: false } }
    );
  }
}

async function ensureLockedAssignmentShifts(owner, events, shifts, settings) {
  const existing = [...shifts];
  const shiftLength = fullShiftLengthMinutes(settings);

  for (const event of events) {
    for (const assignment of event.assignedWorkers || []) {
      if (!assignment.locked || !assignment.worker) continue;
      const worker = assignment.worker;
      const workerId = worker?._id || worker;
      const range = assignmentRange(assignment, event);
      const sameDay = shiftsForWorkerOnDate(existing, workerId, event.date);
      const covering = sameDay.find(shift => shift.startMinutes <= range.start && shift.endMinutes >= range.end);

      if (covering) {
        // Upgrade old event-length manual shifts from earlier versions when it is
        // safe to do so. This keeps legacy data from producing 20-minute shifts.
        if (covering.source === 'manual' && covering.endMinutes - covering.startMinutes < shiftLength && sameDay.length === 1 && worker && typeof worker === 'object') {
          const window = flexibleShiftWindowsCovering(settings, event.date, range.start, range.end).find(candidate =>
            !workerUnavailabilityConflict(worker, { date: event.date, startMinutes: candidate.startMinutes, endMinutes: candidate.endMinutes })
          );
          if (window) {
            covering.startMinutes = window.startMinutes;
            covering.endMinutes = window.endMinutes;
            covering.locked = true;
            await covering.save();
          }
        }
        continue;
      }

      // Never create a second shift for the same worker/day just to satisfy a
      // locked event assignment. Split shifts are deliberately not supported.
      if (sameDay.length) continue;
      if (!worker || typeof worker !== 'object') continue;
      const window = flexibleShiftWindowsCovering(settings, event.date, range.start, range.end).find(candidate =>
        !workerUnavailabilityConflict(worker, { date: event.date, startMinutes: candidate.startMinutes, endMinutes: candidate.endMinutes })
      );
      if (!window) continue;
      const created = await WorkShift.create({
        owner,
        worker: workerId,
        date: event.date,
        startMinutes: window.startMinutes,
        endMinutes: window.endMinutes,
        locked: true,
        source: 'manual'
      });
      existing.push(created);
    }
  }
  return existing;
}

router.get('/', async (req, res) => {
  const weekStart = mondayOf(String(req.query.weekStart || ''));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ message: 'Valid weekStart is required.' });
  const [events, workers, previousEvents, shifts, previousShifts, settings] = await Promise.all([
    populatedWeek(req.userId, weekStart),
    Worker.find({ owner: req.userId }).sort({ name: 1 }),
    populatedWeek(req.userId, addDays(weekStart, -7)),
    populatedShifts(req.userId, weekStart),
    populatedShifts(req.userId, addDays(weekStart, -7)),
    getSettings(req.userId)
  ]);

  const workerStats = Object.fromEntries(workers.map(worker => [String(worker._id), {
    currentHours: effectiveWorkerHours(worker._id, shifts, events),
    previousHours: effectiveWorkerHours(worker._id, previousShifts, previousEvents)
  }]));

  res.json({
    events: events.map(eventJson),
    shifts,
    settings,
    workerStats,
    weekStart
  });
});

router.delete('/clear', async (req, res) => {
  const scope = String(req.body.scope || '');
  let start;
  let end;

  if (scope === 'day') {
    start = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ message: 'Valid date is required.' });
    end = start;
  } else if (scope === 'week') {
    start = mondayOf(String(req.body.weekStart || ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ message: 'Valid week start is required.' });
    end = addDays(start, 6);
  } else {
    return res.status(400).json({ message: 'Clear scope must be day or week.' });
  }

  const [eventResult, shiftResult] = await Promise.all([
    ScheduledEvent.deleteMany({ owner: req.userId, date: { $gte: start, $lte: end } }),
    WorkShift.deleteMany({ owner: req.userId, date: { $gte: start, $lte: end } })
  ]);
  res.json({
    ok: true,
    scope,
    start,
    end,
    eventsDeleted: eventResult.deletedCount,
    shiftsDeleted: shiftResult.deletedCount
  });
});

router.post('/shifts', async (req, res) => {
  const workerId = req.body.workerId ? String(req.body.workerId) : '';
  const worker = workerId ? await Worker.findOne({ _id: workerId, owner: req.userId }) : null;
  if (workerId && !worker) return res.status(404).json({ message: 'Worker not found.' });
  const date = String(req.body.date || '');
  const startMinutes = Number(req.body.startMinutes);
  const endMinutes = Number(req.body.endMinutes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'Valid date is required.' });
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes) || endMinutes - startMinutes < 180) {
    return res.status(400).json({ message: 'A manual shift must be at least three hours long.' });
  }

  const [settings, weekShifts] = await Promise.all([
    getSettings(req.userId),
    populatedShifts(req.userId, mondayOf(date))
  ]);
  const hours = workHoursForDate(settings, date);
  if (startMinutes < hours.openMinutes || endMinutes > hours.closeMinutes) {
    return res.status(400).json({ message: `Shift must fit within that day's workplace hours (${formatMinutes(hours.openMinutes)}–${formatMinutes(hours.closeMinutes)}).` });
  }
  if (worker && shiftsForWorkerOnDate(weekShifts, worker._id, date).length) {
    return res.status(409).json({ message: `${worker.name} already has a shift on this day.` });
  }
  const matchingSavedShift = (settings.shiftBlocks || []).find(block =>
    block.dayOfWeek === getDayOfWeek(date) && block.startMinutes === startMinutes && block.endMinutes === endMinutes
  );
  if (matchingSavedShift) {
    const filled = weekShifts.filter(shift =>
      shift.date === date && (shift.worker
        ? shift.startMinutes <= startMinutes && shift.endMinutes >= endMinutes
        : shift.startMinutes === startMinutes && shift.endMinutes === endMinutes)
    ).length;
    if (filled >= Number(matchingSavedShift.workersNeeded ?? 1)) {
      return res.status(409).json({ message: `${matchingSavedShift.name} already has its requested number of workers.` });
    }
  }
  if (worker) {
    const unavailable = workerUnavailabilityConflict(worker, { date, startMinutes, endMinutes });
    if (unavailable) return res.status(409).json({ message: unavailable.message });
    const projectedHours = calculateWorkerShiftHours(worker._id, weekShifts) + (endMinutes - startMinutes) / 60;
    if (projectedHours > worker.maxWeeklyHours + 1e-9) {
      return res.status(409).json({ message: `This shift would bring ${worker.name} to ${projectedHours.toFixed(1)} hours, above their ${worker.maxWeeklyHours}-hour weekly limit.` });
    }
  }

  const shift = await WorkShift.create({
    owner: req.userId,
    worker: worker?._id || null,
    date,
    startMinutes,
    endMinutes,
    locked: req.body.locked !== false,
    preserveSlot: true,
    source: 'manual'
  });
  await shift.populate('worker');
  res.status(201).json({ shift });
});

router.patch('/shifts/:id/worker', async (req, res) => {
  const shift = await WorkShift.findOne({ _id: req.params.id, owner: req.userId }).populate('worker');
  if (!shift) return res.status(404).json({ message: 'Work shift not found.' });
  if (shift.worker) return res.status(409).json({ message: 'This shift already has a worker. Remove that shift first if you need to replace them.' });

  const worker = await Worker.findOne({ _id: req.body.workerId, owner: req.userId });
  if (!worker) return res.status(404).json({ message: 'Worker not found.' });
  const weekShifts = await populatedShifts(req.userId, mondayOf(shift.date));
  const otherShifts = weekShifts.filter(item => String(item._id) !== String(shift._id));
  if (shiftsForWorkerOnDate(otherShifts, worker._id, shift.date).length) {
    return res.status(409).json({ message: `${worker.name} already has a shift on this day.` });
  }
  const unavailable = workerUnavailabilityConflict(worker, {
    date: shift.date,
    startMinutes: shift.startMinutes,
    endMinutes: shift.endMinutes
  });
  if (unavailable) return res.status(409).json({ message: unavailable.message });
  const projectedHours = calculateWorkerShiftHours(worker._id, otherShifts) + (shift.endMinutes - shift.startMinutes) / 60;
  if (projectedHours > worker.maxWeeklyHours + 1e-9) {
    return res.status(409).json({ message: `This shift would bring ${worker.name} to ${projectedHours.toFixed(1)} hours, above their ${worker.maxWeeklyHours}-hour weekly limit.` });
  }

  shift.worker = worker._id;
  shift.locked = true;
  await shift.save();
  await shift.populate('worker');
  res.json({ shift });
});

router.patch('/shifts/:id/lock', async (req, res) => {
  const shift = await WorkShift.findOne({ _id: req.params.id, owner: req.userId }).populate('worker');
  if (!shift) return res.status(404).json({ message: 'Work shift not found.' });
  shift.locked = Boolean(req.body.locked);
  await shift.save();
  res.json({ shift });
});

router.delete('/shifts/:id', async (req, res) => {
  const shift = await WorkShift.findOne({ _id: req.params.id, owner: req.userId });
  if (!shift) return res.status(404).json({ message: 'Work shift not found.' });

  const operations = [WorkShift.deleteOne({ _id: shift._id })];
  if (shift.worker) {
    operations.push(ScheduledEvent.updateMany(
      { owner: req.userId, date: shift.date },
      { $pull: { assignedWorkers: { worker: shift.worker } } }
    ));
  }
  await Promise.all(operations);
  res.json({ ok: true, shiftId: shift._id });
});

router.post('/', async (req, res) => {
  try {
    const template = await EventTemplate.findOne({ _id: req.body.templateId, owner: req.userId });
    if (!template) return res.status(404).json({ message: 'Event template not found.' });
    const startMinutes = Number(req.body.startMinutes);
    const date = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'Valid date required.' });
    if (!Number.isInteger(startMinutes)) return res.status(400).json({ message: 'Start time must be a whole minute.' });
    if (startMinutes < SCHEDULE_START || startMinutes + template.durationMinutes > SCHEDULE_END) {
      return res.status(400).json({ message: 'Event must fit between 5:00 AM and 10:00 PM.' });
    }

    const dayEvents = await ScheduledEvent.find({ owner: req.userId, date }).sort({ startMinutes: 1 });
    const candidate = { date, startMinutes, durationMinutes: template.durationMinutes };
    const overlap = scheduledEventOverlapConflict(candidate, dayEvents);
    if (overlap) return res.status(409).json({ message: overlap });

    const scheduledEvent = await ScheduledEvent.create({
      owner: req.userId,
      template: template._id,
      name: template.name,
      durationMinutes: template.durationMinutes,
      workersNeeded: template.workersNeeded,
      requiredRoles: template.requiredRoles || [],
      date,
      startMinutes,
      assignedWorkers: []
    });
    res.status(201).json({ event: scheduledEvent });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not place event.' });
  }
});

router.patch('/:id/position', async (req, res) => {
  const event = await ScheduledEvent.findOne({ _id: req.params.id, owner: req.userId }).populate('assignedWorkers.worker');
  if (!event) return res.status(404).json({ message: 'Scheduled event not found.' });
  const date = String(req.body.date || event.date);
  const startMinutes = Number(req.body.startMinutes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'Valid date required.' });
  if (!Number.isInteger(startMinutes)) return res.status(400).json({ message: 'Start time must be a whole minute.' });
  if (startMinutes < SCHEDULE_START || startMinutes + event.durationMinutes > SCHEDULE_END) {
    return res.status(400).json({ message: 'Event must fit between 5:00 AM and 10:00 PM.' });
  }

  const dayEvents = await ScheduledEvent.find({ owner: req.userId, date }).sort({ startMinutes: 1 });
  const movedEvent = { ...event.toObject(), date, startMinutes };
  const scheduleOverlap = scheduledEventOverlapConflict(movedEvent, dayEvents, event._id);
  if (scheduleOverlap) return res.status(409).json({ message: `Cannot move this event: ${scheduleOverlap}` });

  const lockedAssignments = event.assignedWorkers.filter(a => a.locked && a.worker);
  const weekStart = mondayOf(date);
  const [weekEvents, weekShifts] = await Promise.all([
    populatedWeek(req.userId, weekStart),
    populatedShifts(req.userId, weekStart)
  ]);
  for (const assignment of lockedAssignments) {
    const worker = assignment.worker;
    const candidate = { ...movedEvent, startMinutes, endMinutes: startMinutes + event.durationMinutes };
    const unavailable = workerUnavailabilityConflict(worker, candidate);
    if (unavailable) return res.status(409).json({ message: `Cannot move this event: ${unavailable.message}` });
    const overlap = eventOverlapConflict(worker._id, candidate, weekEvents, event._id, startMinutes, startMinutes + event.durationMinutes);
    if (overlap) return res.status(409).json({ message: `Cannot move this event: ${overlap}` });
    if (!shiftCovers(weekShifts, worker._id, date, startMinutes, startMinutes + event.durationMinutes)) {
      return res.status(409).json({
        message: `Cannot move this event: ${worker.name}'s locked assignment would fall outside their existing work shift. Unassign them first or keep the event inside their shift.`
      });
    }
  }

  // Generated assignment segments are tied to generated shifts, so moving an event clears them.
  event.assignedWorkers = event.assignedWorkers.filter(a => a.locked);
  for (const assignment of event.assignedWorkers) {
    assignment.startMinutes = startMinutes;
    assignment.endMinutes = startMinutes + event.durationMinutes;
  }
  event.date = date;
  event.startMinutes = startMinutes;
  await event.save();
  await event.populate('assignedWorkers.worker');
  res.json({ event: eventJson(event) });
});

router.delete('/:id', async (req, res) => {
  const event = await ScheduledEvent.findOne({ _id: req.params.id, owner: req.userId });
  if (!event) return res.status(404).json({ message: 'Scheduled event not found.' });
  const lockedWorkerIds = [...new Set((event.assignedWorkers || [])
    .filter(assignment => assignment.locked)
    .map(assignment => String(assignment.worker?._id || assignment.worker))
    .filter(Boolean))];
  await ScheduledEvent.deleteOne({ _id: event._id });
  for (const workerId of lockedWorkerIds) {
    await cleanupManualShiftIfUnused(req.userId, workerId, event.date);
  }
  res.json({ ok: true });
});

router.post('/:id/assign', async (req, res) => {
  const event = await ScheduledEvent.findOne({ _id: req.params.id, owner: req.userId }).populate('assignedWorkers.worker');
  if (!event) return res.status(404).json({ message: 'Scheduled event not found.' });
  const worker = await Worker.findOne({ _id: req.body.workerId, owner: req.userId });
  if (!worker) return res.status(404).json({ message: 'Worker not found.' });
  if (event.assignedWorkers.some(a => String(a.worker?._id || a.worker) === String(worker._id))) {
    return res.status(409).json({ message: `${worker.name} is already assigned to this event.` });
  }

  const activeFullEvent = event.assignedWorkers.filter(a => {
    const range = assignmentRange(a, event);
    return range.start <= event.startMinutes && range.end >= event.startMinutes + event.durationMinutes;
  });
  if (activeFullEvent.length >= event.workersNeeded) {
    return res.status(409).json({ message: `${event.name} is already fully staffed.` });
  }

  const weekStart = mondayOf(event.date);
  const [weekEvents, shifts, settings] = await Promise.all([
    populatedWeek(req.userId, weekStart),
    populatedShifts(req.userId, weekStart),
    getSettings(req.userId)
  ]);
  const currentHours = effectiveWorkerHours(worker._id, shifts, weekEvents);
  const eventStart = event.startMinutes;
  const eventEnd = event.startMinutes + event.durationMinutes;
  const sameDayShifts = shiftsForWorkerOnDate(shifts, worker._id, event.date);
  let coveringShift = sameDayShifts.find(shift => shift.startMinutes <= eventStart && shift.endMinutes >= eventEnd);

  const unavailable = workerUnavailabilityConflict(worker, { date: event.date, startMinutes: eventStart, endMinutes: eventEnd });
  if (unavailable) return res.status(409).json({ message: unavailable.message });
  const overlap = eventOverlapConflict(worker._id, event, weekEvents, event._id, eventStart, eventEnd);
  if (overlap) return res.status(409).json({ message: overlap });
  const roleCheck = roleAssignmentFeasibility(event, worker);
  if (!roleCheck.ok) return res.status(409).json({ message: roleCheck.message });

  if (!coveringShift) {
    if (sameDayShifts.length) {
      const existing = sameDayShifts[0];
      return res.status(409).json({
        message: `${worker.name} already works ${formatMinutes(existing.startMinutes)}–${formatMinutes(existing.endMinutes)} on this day. MyScheduler does not create split shifts; assign them to an event inside that shift or use another worker.`
      });
    }

    const currentHoursMap = new Map([[String(worker._id), currentHours]]);
    const window = bestFullShiftWindow(worker, event.date, eventStart, eventEnd, settings, shifts, currentHoursMap);
    if (!window) {
      const shiftLength = fullShiftLengthMinutes(settings) / 60;
      return res.status(409).json({
        message: `${worker.name} cannot take a realistic ${shiftLength}-hour shift that covers this event without violating workplace hours, availability, or their weekly hour limit.`
      });
    }

    coveringShift = await WorkShift.create({
      owner: req.userId,
      worker: worker._id,
      date: event.date,
      startMinutes: window.startMinutes,
      endMinutes: window.endMinutes,
      locked: true,
      source: 'manual'
    });
  } else if (!coveringShift.locked) {
    coveringShift.locked = true;
    await coveringShift.save();
  }

  event.assignedWorkers.push({ worker: worker._id, locked: true, startMinutes: eventStart, endMinutes: eventEnd });
  await event.save();
  await event.populate('assignedWorkers.worker');
  res.json({ event: eventJson(event), shift: coveringShift });
});

router.delete('/:id/assign/:workerId', async (req, res) => {
  const event = await ScheduledEvent.findOne({ _id: req.params.id, owner: req.userId });
  if (!event) return res.status(404).json({ message: 'Scheduled event not found.' });
  const workerId = req.params.workerId;
  event.assignedWorkers = event.assignedWorkers.filter(a => String(a.worker?._id || a.worker) !== String(workerId));
  await event.save();
  await cleanupManualShiftIfUnused(req.userId, workerId, event.date, event._id);
  await event.populate('assignedWorkers.worker');
  res.json({ event: eventJson(event) });
});

router.patch('/:id/assign/:workerId/lock', async (req, res) => {
  const event = await ScheduledEvent.findOne({ _id: req.params.id, owner: req.userId });
  if (!event) return res.status(404).json({ message: 'Scheduled event not found.' });
  const assignment = event.assignedWorkers.find(a => String(a.worker) === String(req.params.workerId));
  if (!assignment) return res.status(404).json({ message: 'Assignment not found.' });
  assignment.locked = Boolean(req.body.locked);
  await event.save();
  if (assignment.locked) {
    const range = assignmentRange(assignment, event);
    await WorkShift.updateMany(
      { owner: req.userId, worker: req.params.workerId, date: event.date, startMinutes: { $lte: range.start }, endMinutes: { $gte: range.end } },
      { $set: { locked: true } }
    );
  } else {
    const dayEvents = await ScheduledEvent.find({ owner: req.userId, date: event.date });
    const stillLockedElsewhere = dayEvents.some(dayEvent => (dayEvent.assignedWorkers || []).some(item =>
      String(item.worker?._id || item.worker) === String(req.params.workerId) && item.locked
    ));
    if (!stillLockedElsewhere) {
      await WorkShift.updateMany(
        { owner: req.userId, worker: req.params.workerId, date: event.date, source: { $in: ['manual', 'generated'] } },
        { $set: { locked: false } }
      );
    }
  }
  await event.populate('assignedWorkers.worker');
  res.json({ event: eventJson(event) });
});

function scoreWorker(worker, currentHours, previousHours) {
  const current = currentHours.get(String(worker._id)) || 0;
  const previous = previousHours.get(String(worker._id)) || 0;
  const utilization = worker.maxWeeklyHours ? current / worker.maxWeeklyHours : 1;
  return current * 1.45 + previous * 0.8 + utilization * 3 + Math.random() * 1.75;
}

function weightedPick(candidates, currentHours, previousHours) {
  if (!candidates.length) return null;
  const scored = candidates.map(worker => ({ worker, score: scoreWorker(worker, currentHours, previousHours) })).sort((a, b) => a.score - b.score);
  const pool = scored.slice(0, Math.min(4, scored.length));
  const floor = pool[0].score;
  const weights = pool.map(item => 1 / (1 + Math.max(0, item.score - floor)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i].worker;
  }
  return pool[0].worker;
}

router.post('/auto-generate/run', async (req, res) => {
  const weekStart = mondayOf(String(req.body.weekStart || ''));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ message: 'Valid weekStart is required.' });

  const [workers, settings, previousEvents, previousShifts] = await Promise.all([
    Worker.find({ owner: req.userId }),
    getSettings(req.userId),
    populatedWeek(req.userId, addDays(weekStart, -7)),
    populatedShifts(req.userId, addDays(weekStart, -7))
  ]);
  let events = await populatedWeek(req.userId, weekStart);
  let shifts = await populatedShifts(req.userId, weekStart);

  // Keep intentional choices and rebuild only generated work.
  for (const event of events) {
    event.assignedWorkers = event.assignedWorkers.filter(a => a.locked);
    await event.save();
  }
  await WorkShift.updateMany({
    owner: req.userId,
    date: { $gte: weekStart, $lte: addDays(weekStart, 6) },
    preserveSlot: true,
    locked: false
  }, { $set: { worker: null, locked: true } });
  await WorkShift.deleteMany({
    owner: req.userId,
    date: { $gte: weekStart, $lte: addDays(weekStart, 6) },
    locked: false,
    preserveSlot: { $ne: true }
  });
  events = await populatedWeek(req.userId, weekStart);
  shifts = await populatedShifts(req.userId, weekStart);
  await ensureLockedAssignmentShifts(req.userId, events, shifts, settings);
  shifts = await populatedShifts(req.userId, weekStart);

  const previousHours = new Map(workers.map(worker => [
    String(worker._id),
    effectiveWorkerHours(worker._id, previousShifts, previousEvents)
  ]));
  const currentHours = new Map(workers.map(worker => [
    String(worker._id),
    effectiveWorkerHours(worker._id, shifts, events)
  ]));
  const issues = [];

  function windowRespectsRoleConcurrency(worker, date, window) {
    return events.every(event => {
      if (event.date !== date || !rangesOverlap(window.startMinutes, window.endMinutes, event.startMinutes, event.startMinutes + event.durationMinutes)) return true;
      return (event.requiredRoles || []).every(requirement => {
        if (!workerHasRole(worker, requirement.role)) return true;
        const sameRoleAlreadyWorking = shifts.filter(shift =>
          shift.date === date && shift.worker &&
          rangesOverlap(shift.startMinutes, shift.endMinutes, window.startMinutes, window.endMinutes) &&
          rangesOverlap(shift.startMinutes, shift.endMinutes, event.startMinutes, event.startMinutes + event.durationMinutes) &&
          workerHasRole(shift.worker, requirement.role)
        ).length;
        return sameRoleAlreadyWorking < Math.max(0, Number(requirement.count) || 0);
      });
    });
  }

  async function addShift(worker, date, window) {
    const created = await WorkShift.create({
      owner: req.userId,
      worker: worker._id,
      date,
      startMinutes: window.startMinutes,
      endMinutes: window.endMinutes,
      locked: false,
      source: 'generated'
    });
    await created.populate('worker');
    shifts.push(created);
    currentHours.set(
      String(worker._id),
      (currentHours.get(String(worker._id)) || 0) + (window.endMinutes - window.startMinutes) / 60
    );
    return created;
  }

  // Open custom shifts preserve the user's chosen date and time. Fill those
  // slots before generating saved shift blocks so they count toward coverage.
  let filledOpenShifts = 0;
  const openShifts = shifts
    .filter(shift => !shift.worker)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  for (const shift of openShifts) {
    const window = { startMinutes: shift.startMinutes, endMinutes: shift.endMinutes };
    const candidates = workers.filter(worker =>
      workerCanTakeFullShift(worker, shift.date, window, shifts, currentHours) &&
      windowRespectsRoleConcurrency(worker, shift.date, window)
    );
    const worker = weightedPick(candidates, currentHours, previousHours);
    if (!worker) {
      issues.push({
        type: 'open-shift',
        shiftId: String(shift._id),
        date: shift.date,
        time: shift.startMinutes,
        message: `The open shift from ${formatMinutes(shift.startMinutes)}–${formatMinutes(shift.endMinutes)} has no available worker.`
      });
      continue;
    }

    shift.worker = worker._id;
    shift.locked = true;
    await shift.save();
    await shift.populate('worker');
    currentHours.set(
      String(worker._id),
      (currentHours.get(String(worker._id)) || 0) + (shift.endMinutes - shift.startMinutes) / 60
    );
    filledOpenShifts++;
  }

  // Generate only the user-defined shift blocks. Existing locked shifts that
  // fully cover a block count toward its requested staffing level.
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = addDays(weekStart, dayOffset);
    const blocks = (settings.shiftBlocks || [])
      .filter(block => block.dayOfWeek === getDayOfWeek(date))
      .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
    for (const block of blocks) {
      const window = { startMinutes: block.startMinutes, endMinutes: block.endMinutes };
      let covering = shifts.filter(shift =>
        shift.date === date && shift.worker &&
        shift.startMinutes <= block.startMinutes && shift.endMinutes >= block.endMinutes
      );
      let safety = 0;
      const requestedWorkers = Math.max(0, Number(block.workersNeeded ?? 1) || 0);
      while (covering.length < requestedWorkers && safety++ < 100) {
        const candidates = workers.filter(worker =>
          workerCanTakeFullShift(worker, date, window, shifts, currentHours) &&
          windowRespectsRoleConcurrency(worker, date, window)
        );
        const worker = weightedPick(candidates, currentHours, previousHours);
        if (!worker) {
          issues.push({
            type: 'saved-shift',
            date,
            time: block.startMinutes,
            message: `${block.name} has only ${covering.length}/${requestedWorkers} workers available.`
          });
          break;
        }
        await addShift(worker, date, window);
        covering = shifts.filter(shift =>
          shift.date === date && shift.worker &&
          shift.startMinutes <= block.startMinutes && shift.endMinutes >= block.endMinutes
        );
      }
    }
  }

  // Assign workers who are already on-site to events. Prefer keeping the same
  // worker on the event across adjacent segments, only handing off when their
  // actual workplace shift ends or a role requirement forces a change.
  events = await populatedWeek(req.userId, weekStart);
  for (const event of events) {
    const eventStart = event.startMinutes;
    const eventEnd = event.startMinutes + event.durationMinutes;
    const dayShifts = shifts.filter(shift =>
      shift.date === event.date && shift.worker &&
      rangesOverlap(eventStart, eventEnd, shift.startMinutes, shift.endMinutes)
    );
    const boundaries = new Set([eventStart, eventEnd]);
    dayShifts.forEach(shift => {
      boundaries.add(Math.max(eventStart, shift.startMinutes));
      boundaries.add(Math.min(eventEnd, shift.endMinutes));
    });
    const points = [...boundaries].filter(value => value >= eventStart && value <= eventEnd).sort((a, b) => a - b);
    const selections = new Map();
    let previousSegmentIds = new Set();

    for (const assignment of event.assignedWorkers.filter(a => a.locked && a.worker)) {
      const id = String(assignment.worker._id || assignment.worker);
      const range = assignmentRange(assignment, event);
      selections.set(id, { worker: assignment.worker, start: range.start, end: range.end, locked: true });
    }

    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      if (end <= start) continue;

      const activeLocked = [...selections.values()]
        .filter(item => item.locked && item.start <= start && item.end >= end)
        .map(item => item.worker);
      const availableWorkers = dayShifts
        .filter(shift => shift.startMinutes <= start && shift.endMinutes >= end)
        .map(shift => shift.worker)
        .filter((worker, index, array) => array.findIndex(item => String(item._id) === String(worker._id)) === index);

      const chosenWorkers = [...activeLocked];
      const chosenIds = new Set(chosenWorkers.map(worker => String(worker._id)));
      const continuing = availableWorkers.filter(worker => previousSegmentIds.has(String(worker._id)) && !chosenIds.has(String(worker._id)));

      let missingRoles = missingRoleSlots(chosenWorkers, event.requiredRoles || []);
      for (const role of missingRoles) {
        let chosen = continuing.find(worker => !chosenIds.has(String(worker._id)) && workerHasRole(worker, role));
        if (!chosen) {
          const candidates = availableWorkers.filter(worker =>
            !chosenIds.has(String(worker._id)) && workerHasRole(worker, role)
          );
          chosen = weightedPick(candidates, currentHours, previousHours);
        }
        if (!chosen) continue;
        chosenWorkers.push(chosen);
        chosenIds.add(String(chosen._id));
      }

      for (const worker of continuing) {
        if (chosenWorkers.length >= event.workersNeeded) break;
        if (chosenIds.has(String(worker._id))) continue;
        chosenWorkers.push(worker);
        chosenIds.add(String(worker._id));
      }

      while (chosenWorkers.length < event.workersNeeded) {
        const candidates = availableWorkers.filter(worker => !chosenIds.has(String(worker._id)));
        const chosen = weightedPick(candidates, currentHours, previousHours);
        if (!chosen) break;
        chosenWorkers.push(chosen);
        chosenIds.add(String(chosen._id));
      }

      const segmentMissingRoles = missingRoleSlots(chosenWorkers, event.requiredRoles || []);
      if (chosenWorkers.length < event.workersNeeded || segmentMissingRoles.length) {
        issues.push({
          type: 'event',
          event: event.name,
          date: event.date,
          time: start,
          message: `${event.name} is not fully staffed from ${formatMinutes(start)}–${formatMinutes(end)}${segmentMissingRoles.length ? `; missing role: ${segmentMissingRoles.join(', ')}` : ''}.`
        });
      }

      for (const worker of chosenWorkers) {
        const id = String(worker._id);
        const existing = selections.get(id);
        if (existing?.locked) continue;
        if (existing && existing.end === start) existing.end = end;
        else if (!existing) selections.set(id, { worker, start, end, locked: false });
      }
      previousSegmentIds = new Set(chosenWorkers.map(worker => String(worker._id)));
    }

    event.assignedWorkers = [...selections.values()].map(item => ({
      worker: item.worker._id || item.worker,
      locked: item.locked,
      startMinutes: item.start,
      endMinutes: item.end
    }));
    await event.save();
  }

  const [refreshedEvents, refreshedShifts] = await Promise.all([
    populatedWeek(req.userId, weekStart),
    populatedShifts(req.userId, weekStart)
  ]);
  const uniqueIssues = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = `${issue.type}|${issue.shiftId || ''}|${issue.date}|${issue.time}|${issue.event || ''}|${issue.role || ''}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueIssues.push(issue);
  }

  res.json({
    events: refreshedEvents.map(eventJson),
    shifts: refreshedShifts,
    issues: uniqueIssues,
    assignments: refreshedEvents.reduce((sum, event) => sum + event.assignedWorkers.length, 0),
    generatedShifts: refreshedShifts.filter(shift => !shift.locked).length,
    filledOpenShifts,
    settings
  });
});

export default router;
