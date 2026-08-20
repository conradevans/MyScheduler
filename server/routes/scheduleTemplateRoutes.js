import express from 'express';
import ScheduleTemplate from '../models/ScheduleTemplate.js';
import ScheduledEvent from '../models/ScheduledEvent.js';
import Worker from '../models/Worker.js';
import WorkShift from '../models/WorkShift.js';
import WorkplaceSettings from '../models/WorkplaceSettings.js';
import { requireAuth } from '../middleware/auth.js';
import { addDays, getDayOfWeek, getWeekRange, mondayOf, SCHEDULE_END, SCHEDULE_START, rangesOverlap } from '../utils/dates.js';
import {
  calculateWorkerShiftHours,
  scheduledEventOverlapConflict,
  workerUnavailabilityConflict,
  shiftOverlapConflict,
  eventOverlapConflict,
  roleAssignmentFeasibility
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
  return WorkShift.find({ owner, date: { $gte: start, $lte: end } }).populate('worker').sort({ date: 1, startMinutes: 1 });
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
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

function fullShiftLengthMinutes(settings) {
  return Math.max(180, Math.round((Number(settings?.shiftLengthHours) || 4) * 60));
}

function workHoursForDate(settings, date) {
  const day = (settings.dailyHours || []).find(row => row.dayOfWeek === getDayOfWeek(date));
  return { openMinutes: day?.openMinutes ?? settings.openMinutes, closeMinutes: day?.closeMinutes ?? settings.closeMinutes };
}

function flexibleShiftWindowCovering(settings, date, coverStart, coverEnd) {
  const { openMinutes, closeMinutes } = workHoursForDate(settings, date);
  const target = fullShiftLengthMinutes(settings);
  let startMinutes = Math.max(openMinutes, coverStart);
  let endMinutes = Math.min(closeMinutes, startMinutes + target);
  if (endMinutes - startMinutes < 180) startMinutes = Math.max(openMinutes, endMinutes - 180);
  if (startMinutes > coverStart || endMinutes < coverEnd || endMinutes - startMinutes < 180) return null;
  return { startMinutes, endMinutes };
}

function workerDayShifts(shifts, workerId, date) {
  return shifts.filter(shift => String(shift.worker?._id || shift.worker) === String(workerId) && shift.date === date);
}

function snapshotEvent(event, dayOffset) {
  return {
    dayOffset,
    template: event.template,
    name: event.name,
    durationMinutes: event.durationMinutes,
    workersNeeded: event.workersNeeded,
    requiredRoles: event.requiredRoles || [],
    startMinutes: event.startMinutes,
    assignments: (event.assignedWorkers || [])
      .filter(assignment => assignment.worker)
      .map(assignment => ({
        worker: assignment.worker?._id || assignment.worker,
        startMinutes: assignment.startMinutes ?? event.startMinutes,
        endMinutes: assignment.endMinutes ?? (event.startMinutes + event.durationMinutes)
      }))
  };
}

function snapshotShift(shift, dayOffset) {
  return {
    dayOffset,
    worker: shift.worker?._id || shift.worker || null,
    startMinutes: shift.startMinutes,
    endMinutes: shift.endMinutes,
    preserveSlot: shift.preserveSlot !== false
  };
}

router.get('/', async (req, res) => {
  const templates = await ScheduleTemplate.find({ owner: req.userId }).sort({ type: 1, name: 1, createdAt: -1 });
  res.json({ templates });
});

router.post('/', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const type = String(req.body.type || '');
    if (!name) return res.status(400).json({ message: 'Template name is required.' });
    if (!['day', 'week'].includes(type)) return res.status(400).json({ message: 'Template type must be day or week.' });

    let sourceEvents = [];
    let sourceShifts = [];
    if (type === 'day') {
      const sourceDate = String(req.body.sourceDate || '');
      if (!validDate(sourceDate)) return res.status(400).json({ message: 'Choose a valid source day.' });
      const [events, shifts] = await Promise.all([
        ScheduledEvent.find({ owner: req.userId, date: sourceDate }).populate('assignedWorkers.worker').sort({ startMinutes: 1 }),
        WorkShift.find({ owner: req.userId, date: sourceDate }).populate('worker').sort({ startMinutes: 1 })
      ]);
      sourceEvents = events.map(event => snapshotEvent(event, 0));
      sourceShifts = shifts.map(shift => snapshotShift(shift, 0));
    } else {
      const weekStart = mondayOf(String(req.body.weekStart || ''));
      if (!validDate(weekStart)) return res.status(400).json({ message: 'Choose a valid source week.' });
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const date = addDays(weekStart, dayOffset);
        const [events, shifts] = await Promise.all([
          ScheduledEvent.find({ owner: req.userId, date }).populate('assignedWorkers.worker').sort({ startMinutes: 1 }),
          WorkShift.find({ owner: req.userId, date }).populate('worker').sort({ startMinutes: 1 })
        ]);
        sourceEvents.push(...events.map(event => snapshotEvent(event, dayOffset)));
        sourceShifts.push(...shifts.map(shift => snapshotShift(shift, dayOffset)));
      }
    }

    if (!sourceEvents.length && !sourceShifts.length) {
      return res.status(400).json({ message: `There is no schedule in that ${type}.` });
    }

    const template = await ScheduleTemplate.create({ owner: req.userId, name, type, events: sourceEvents, shifts: sourceShifts });
    res.status(201).json({ template });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not save schedule template.' });
  }
});

router.delete('/:id', async (req, res) => {
  const result = await ScheduleTemplate.deleteOne({ _id: req.params.id, owner: req.userId });
  if (!result.deletedCount) return res.status(404).json({ message: 'Schedule template not found.' });
  res.json({ ok: true });
});

router.post('/:id/apply', async (req, res) => {
  try {
    const template = await ScheduleTemplate.findOne({ _id: req.params.id, owner: req.userId });
    if (!template) return res.status(404).json({ message: 'Schedule template not found.' });

    const copyWorkers = Boolean(req.body.copyWorkers);
    let targetStart;
    if (template.type === 'day') {
      targetStart = String(req.body.targetDate || '');
      if (!validDate(targetStart)) return res.status(400).json({ message: 'Choose a valid target day.' });
    } else {
      targetStart = mondayOf(String(req.body.weekStart || ''));
      if (!validDate(targetStart)) return res.status(400).json({ message: 'Choose a valid target week.' });
    }

    const candidates = template.events.map(entry => ({
      entry,
      date: template.type === 'day' ? targetStart : addDays(targetStart, entry.dayOffset),
      startMinutes: entry.startMinutes,
      durationMinutes: entry.durationMinutes
    }));

    for (const candidate of candidates) {
      if (candidate.startMinutes < SCHEDULE_START || candidate.startMinutes + candidate.durationMinutes > SCHEDULE_END) {
        return res.status(400).json({ message: `${candidate.entry.name} would fall outside the 5:00 AM–10:00 PM schedule.` });
      }
    }

    const dates = template.type === 'day'
      ? [targetStart]
      : Array.from({ length: 7 }, (_, dayOffset) => addDays(targetStart, dayOffset));
    const planned = [];
    for (const candidate of candidates) {
      const plannedSameDay = planned.filter(event => event.date === candidate.date);
      const overlap = scheduledEventOverlapConflict(candidate, plannedSameDay);
      if (overlap) return res.status(409).json({ message: `The saved template contains overlapping events on ${candidate.date}: ${overlap}` });
      planned.push(candidate);
    }

    // Applying a template is a replacement operation. Clear every destination
    // day in scope, including days that are intentionally empty in a week template.
    await Promise.all([
      ScheduledEvent.deleteMany({ owner: req.userId, date: { $in: dates } }),
      WorkShift.deleteMany({ owner: req.userId, date: { $in: dates } })
    ]);

    const eventDocuments = candidates.map(candidate => ({
      owner: req.userId,
      template: candidate.entry.template,
      name: candidate.entry.name,
      durationMinutes: candidate.entry.durationMinutes,
      workersNeeded: candidate.entry.workersNeeded,
      requiredRoles: candidate.entry.requiredRoles || [],
      date: candidate.date,
      startMinutes: candidate.entry.startMinutes,
      assignedWorkers: []
    }));
    const created = eventDocuments.length ? await ScheduledEvent.create(eventDocuments) : [];

    const issues = [];
    let copiedAssignments = 0;
    let copiedShifts = 0;

    if (copyWorkers) {
      const targetWeekStart = mondayOf(targetStart);
      const [workers, settings] = await Promise.all([
        Worker.find({ owner: req.userId }),
        getSettings(req.userId)
      ]);
      const workerMap = new Map(workers.map(worker => [String(worker._id), worker]));
      let weekShifts = await populatedShifts(req.userId, targetWeekStart);
      const currentHours = new Map(workers.map(worker => [String(worker._id), calculateWorkerShiftHours(worker._id, weekShifts)]));

      const savedShifts = template.shifts || [];
      for (const savedShift of savedShifts) {
        const date = template.type === 'day' ? targetStart : addDays(targetStart, savedShift.dayOffset);
        const candidateShift = { date, startMinutes: savedShift.startMinutes, endMinutes: savedShift.endMinutes };
        const dayHours = workHoursForDate(settings, date);
        if (candidateShift.startMinutes < dayHours.openMinutes || candidateShift.endMinutes > dayHours.closeMinutes || candidateShift.endMinutes - candidateShift.startMinutes < 180) {
          issues.push({ event: 'Work shift', worker: savedShift.worker ? 'Saved worker' : 'Unassigned', reason: 'This saved shift does not fit the destination day’s workplace hours or three-hour minimum.' });
          continue;
        }

        if (!savedShift.worker) {
          const shift = await WorkShift.create({ owner: req.userId, worker: null, ...candidateShift, locked: true, preserveSlot: savedShift.preserveSlot !== false, source: 'template' });
          weekShifts.push(shift);
          copiedShifts++;
          continue;
        }

        const workerId = String(savedShift.worker?._id || savedShift.worker);
        const worker = workerMap.get(workerId);
        if (!worker) {
          issues.push({ event: 'Work shift', worker: 'Removed worker', reason: 'This worker no longer exists.' });
          continue;
        }
        const sameDay = workerDayShifts(weekShifts, worker._id, date);
        if (sameDay.length) {
          issues.push({ event: 'Work shift', worker: worker.name, reason: `${worker.name} already has a shift on this day. MyScheduler does not copy split shifts.` });
          continue;
        }
        const unavailable = workerUnavailabilityConflict(worker, candidateShift);
        if (unavailable) {
          issues.push({ event: 'Work shift', worker: worker.name, reason: unavailable.message });
          continue;
        }
        const overlap = shiftOverlapConflict(worker._id, candidateShift, weekShifts);
        if (overlap) {
          issues.push({ event: 'Work shift', worker: worker.name, reason: overlap });
          continue;
        }
        const shiftHours = (candidateShift.endMinutes - candidateShift.startMinutes) / 60;
        const projected = (currentHours.get(workerId) || 0) + shiftHours;
        if (projected > worker.maxWeeklyHours + 1e-9) {
          issues.push({ event: 'Work shift', worker: worker.name, reason: `This shift would bring them to ${projected.toFixed(1)} hours, above their ${worker.maxWeeklyHours}-hour weekly limit.` });
          continue;
        }
        const shift = await WorkShift.create({ owner: req.userId, worker: worker._id, ...candidateShift, locked: true, preserveSlot: savedShift.preserveSlot !== false, source: 'template' });
        await shift.populate('worker');
        weekShifts.push(shift);
        currentHours.set(workerId, projected);
        copiedShifts++;
      }

      const weekEvents = await populatedWeek(req.userId, targetWeekStart);
      for (let index = 0; index < created.length; index++) {
        const sourceEntry = candidates[index].entry;
        const liveEvent = weekEvents.find(event => String(event._id) === String(created[index]._id));
        if (!liveEvent) continue;

        for (const savedAssignment of sourceEntry.assignments || []) {
          const workerId = String(savedAssignment.worker?._id || savedAssignment.worker);
          const worker = workerMap.get(workerId);
          if (!worker) continue;
          const start = savedAssignment.startMinutes ?? liveEvent.startMinutes;
          const end = savedAssignment.endMinutes ?? (liveEvent.startMinutes + liveEvent.durationMinutes);
          if (liveEvent.assignedWorkers.some(a => String(a.worker?._id || a.worker) === workerId && (a.startMinutes ?? liveEvent.startMinutes) === start)) continue;

          const unavailable = workerUnavailabilityConflict(worker, { date: liveEvent.date, startMinutes: start, endMinutes: end });
          if (unavailable) {
            issues.push({ event: liveEvent.name, worker: worker.name, reason: unavailable.message });
            continue;
          }
          const overlap = eventOverlapConflict(worker._id, liveEvent, weekEvents, liveEvent._id, start, end);
          if (overlap) {
            issues.push({ event: liveEvent.name, worker: worker.name, reason: overlap });
            continue;
          }
          const roleCheck = roleAssignmentFeasibility(liveEvent, worker);
          if (!roleCheck.ok) {
            issues.push({ event: liveEvent.name, worker: worker.name, reason: roleCheck.message });
            continue;
          }
          const coveredByShift = weekShifts.some(shift => String(shift.worker?._id || shift.worker) === workerId && shift.date === liveEvent.date && shift.startMinutes <= start && shift.endMinutes >= end);
          if (!coveredByShift) {
            const sameDay = workerDayShifts(weekShifts, worker._id, liveEvent.date);
            if (sameDay.length) {
              issues.push({ event: liveEvent.name, worker: worker.name, reason: `${worker.name} already works another shift that day; copying this would create a split shift.` });
              continue;
            }
            const candidateWindow = flexibleShiftWindowCovering(settings, liveEvent.date, start, end);
            if (!candidateWindow) {
              issues.push({ event: liveEvent.name, worker: worker.name, reason: 'No continuous shift of at least three hours can cover this assignment within workplace hours.' });
              continue;
            }
            if (workerUnavailabilityConflict(worker, { date: liveEvent.date, ...candidateWindow })) {
              issues.push({ event: liveEvent.name, worker: worker.name, reason: 'The worker is unavailable during the shift needed for this assignment.' });
              continue;
            }
            const candidateShift = { date: liveEvent.date, ...candidateWindow };
            const shiftOverlap = shiftOverlapConflict(worker._id, candidateShift, weekShifts);
            const shiftHours = (candidateShift.endMinutes - candidateShift.startMinutes) / 60;
            const projected = (currentHours.get(workerId) || 0) + shiftHours;
            if (shiftOverlap || projected > worker.maxWeeklyHours + 1e-9) {
              issues.push({ event: liveEvent.name, worker: worker.name, reason: shiftOverlap || 'Copying this assignment would exceed the weekly hour limit.' });
              continue;
            }
            const fallbackShift = await WorkShift.create({ owner: req.userId, worker: worker._id, ...candidateShift, locked: true, source: 'template' });
            await fallbackShift.populate('worker');
            weekShifts.push(fallbackShift);
            currentHours.set(workerId, projected);
            copiedShifts++;
          }

          liveEvent.assignedWorkers.push({ worker: worker._id, locked: true, startMinutes: start, endMinutes: end });
          await liveEvent.save();
          await liveEvent.populate('assignedWorkers.worker');
          copiedAssignments++;
        }
      }
    }

    const destinationWeek = mondayOf(targetStart);
    const refreshed = await populatedWeek(req.userId, destinationWeek);
    res.status(201).json({
      eventsCreated: created.length,
      copiedAssignments,
      copiedShifts,
      skippedAssignments: issues.length,
      issues,
      destinationWeek,
      events: refreshed
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not apply schedule template.' });
  }
});

export default router;
