import { getDayOfWeek, rangesOverlap } from './dates.js';

export function normalizeRole(value = '') {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function workerHasRole(worker, role) {
  const target = normalizeRole(role);
  return Boolean(target) && (worker.roles || []).some(item => normalizeRole(item) === target);
}

export function workerUnavailabilityConflict(worker, event) {
  const eventStart = event.startMinutes;
  const eventEnd = event.endMinutes ?? (event.startMinutes + event.durationMinutes);
  const dayOfWeek = getDayOfWeek(event.date);

  for (const rule of worker.recurringUnavailable || []) {
    if (rule.dayOfWeek !== dayOfWeek) continue;
    if (rule.allDay) {
      return { type: 'recurring', message: `${worker.name} is unavailable every ${dayName(dayOfWeek)}.` };
    }
    if (rangesOverlap(eventStart, eventEnd, rule.startMinutes ?? 0, rule.endMinutes ?? 1440)) {
      return {
        type: 'recurring',
        message: `${worker.name} has a recurring ${dayName(dayOfWeek)} restriction from ${formatMinutes(rule.startMinutes)} to ${formatMinutes(rule.endMinutes)}.`
      };
    }
  }

  for (const block of worker.dateUnavailable || []) {
    if (event.date < block.startDate || event.date > block.endDate) continue;
    if (block.allDay) {
      return {
        type: 'date',
        message: `${worker.name} is unavailable on ${friendlyDate(event.date)}${block.reason ? ` (${block.reason})` : ''}.`
      };
    }
    if (rangesOverlap(eventStart, eventEnd, block.startMinutes ?? 0, block.endMinutes ?? 1440)) {
      return {
        type: 'date',
        message: `${worker.name} is unavailable on ${friendlyDate(event.date)} from ${formatMinutes(block.startMinutes)} to ${formatMinutes(block.endMinutes)}${block.reason ? ` (${block.reason})` : ''}.`
      };
    }
  }

  return null;
}

export function scheduledEventOverlapConflict(targetEvent, events, ignoreEventId = null) {
  const targetStart = targetEvent.startMinutes;
  const targetEnd = targetEvent.startMinutes + targetEvent.durationMinutes;

  for (const event of events) {
    if (ignoreEventId && String(event._id) === String(ignoreEventId)) continue;
    if (event.date !== targetEvent.date) continue;
    const eventEnd = event.startMinutes + event.durationMinutes;
    if (rangesOverlap(targetStart, targetEnd, event.startMinutes, eventEnd)) {
      return `This event overlaps ${event.name} (${formatMinutes(event.startMinutes)}–${formatMinutes(eventEnd)}). Events cannot overlap.`;
    }
  }

  return null;
}

function assignmentRange(assignment, event) {
  return {
    start: assignment.startMinutes ?? event.startMinutes,
    end: assignment.endMinutes ?? (event.startMinutes + event.durationMinutes)
  };
}

export function eventOverlapConflict(workerId, targetEvent, weekEvents, ignoreEventId = null, assignmentStart = null, assignmentEnd = null) {
  const targetStart = assignmentStart ?? targetEvent.startMinutes;
  const targetEnd = assignmentEnd ?? (targetEvent.startMinutes + targetEvent.durationMinutes);

  for (const event of weekEvents) {
    if (ignoreEventId && String(event._id) === String(ignoreEventId)) continue;
    if (event.date !== targetEvent.date) continue;
    const assignment = (event.assignedWorkers || []).find(a => String(a.worker?._id || a.worker) === String(workerId));
    if (!assignment) continue;
    const range = assignmentRange(assignment, event);
    if (rangesOverlap(targetStart, targetEnd, range.start, range.end)) {
      return `${workerNameFromAssignment(event, workerId) || 'This worker'} is already scheduled for ${event.name} from ${formatMinutes(range.start)} to ${formatMinutes(range.end)}.`;
    }
  }
  return null;
}

export function shiftOverlapConflict(workerId, targetShift, shifts, ignoreShiftId = null) {
  for (const shift of shifts || []) {
    if (ignoreShiftId && String(shift._id) === String(ignoreShiftId)) continue;
    if (String(shift.worker?._id || shift.worker) !== String(workerId)) continue;
    if (shift.date !== targetShift.date) continue;
    if (rangesOverlap(targetShift.startMinutes, targetShift.endMinutes, shift.startMinutes, shift.endMinutes)) {
      return `This worker already has a work shift from ${formatMinutes(shift.startMinutes)} to ${formatMinutes(shift.endMinutes)}.`;
    }
  }
  return null;
}

export function calculateWorkerHours(workerId, events) {
  let minutes = 0;
  for (const event of events) {
    for (const assignment of event.assignedWorkers || []) {
      if (String(assignment.worker?._id || assignment.worker) !== String(workerId)) continue;
      const range = assignmentRange(assignment, event);
      minutes += Math.max(0, range.end - range.start);
    }
  }
  return minutes / 60;
}

export function calculateWorkerShiftHours(workerId, shifts) {
  let minutes = 0;
  for (const shift of shifts || []) {
    if (String(shift.worker?._id || shift.worker) !== String(workerId)) continue;
    minutes += Math.max(0, shift.endMinutes - shift.startMinutes);
  }
  return minutes / 60;
}

export function roleCountsForEvent(event) {
  const counts = new Map();
  for (const requirement of event.requiredRoles || []) {
    const key = normalizeRole(requirement.role);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + Math.max(0, Number(requirement.count) || 0));
  }
  return counts;
}

export function missingRoleSlots(workers, requiredRoles = []) {
  const slots = [];
  for (const requirement of requiredRoles || []) {
    const role = normalizeRole(requirement.role);
    const count = Math.max(0, Number(requirement.count) || 0);
    for (let i = 0; i < count; i++) slots.push(role);
  }
  if (!slots.length) return [];

  const usableWorkers = (workers || []).filter(Boolean);
  const matchedWorkerForSlot = Array(slots.length).fill(-1);

  function tryMatch(workerIndex, seen) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      if (seen.has(slotIndex)) continue;
      if (!workerHasRole(usableWorkers[workerIndex], slots[slotIndex])) continue;
      seen.add(slotIndex);
      if (matchedWorkerForSlot[slotIndex] === -1 || tryMatch(matchedWorkerForSlot[slotIndex], seen)) {
        matchedWorkerForSlot[slotIndex] = workerIndex;
        return true;
      }
    }
    return false;
  }

  for (let workerIndex = 0; workerIndex < usableWorkers.length; workerIndex++) {
    tryMatch(workerIndex, new Set());
  }

  return slots.filter((_, index) => matchedWorkerForSlot[index] === -1);
}

export function roleRequirementStatus(event) {
  const workers = (event.assignedWorkers || []).map(a => a.worker).filter(w => w && typeof w === 'object');
  const missing = missingRoleSlots(workers, event.requiredRoles || []);
  const required = [...roleCountsForEvent(event).entries()].map(([role, count]) => ({ role, count }));
  return { required, missing };
}

export function roleAssignmentFeasibility(event, worker) {
  if (!(event.requiredRoles || []).length) return { ok: true };
  const workers = (event.assignedWorkers || []).map(a => a.worker).filter(w => w && typeof w === 'object');
  workers.push(worker);
  const remainingSlots = Math.max(0, event.workersNeeded - workers.length);
  const missing = missingRoleSlots(workers, event.requiredRoles || []);
  if (missing.length > remainingSlots) {
    const counts = new Map();
    missing.forEach(role => counts.set(role, (counts.get(role) || 0) + 1));
    const label = [...counts.entries()].map(([role, count]) => `${count} ${role}`).join(' and ');
    return {
      ok: false,
      message: `${event.name} still needs ${label}. Assign a worker with a required role before filling the remaining general position${remainingSlots === 1 ? '' : 's'}.`
    };
  }
  return { ok: true };
}

export function eventRoleCoverageOk(event) {
  const workers = (event.assignedWorkers || []).map(a => a.worker).filter(w => w && typeof w === 'object');
  return missingRoleSlots(workers, event.requiredRoles || []).length === 0;
}

export function canAssignWorker({ worker, event, weekEvents, currentHours, assignmentStart = null, assignmentEnd = null }) {
  const start = assignmentStart ?? event.startMinutes;
  const end = assignmentEnd ?? (event.startMinutes + event.durationMinutes);
  const unavailable = workerUnavailabilityConflict(worker, { ...event, startMinutes: start, endMinutes: end });
  if (unavailable) return { ok: false, message: unavailable.message };

  const overlap = eventOverlapConflict(worker._id, event, weekEvents, event._id, start, end);
  if (overlap) return { ok: false, message: overlap };

  const projected = currentHours + (end - start) / 60;
  if (projected > worker.maxWeeklyHours + 1e-9) {
    return {
      ok: false,
      message: `Assigning ${worker.name} to ${event.name} would bring them to ${projected.toFixed(1)} hours this week, above their ${worker.maxWeeklyHours}-hour limit.`
    };
  }

  const roleCheck = roleAssignmentFeasibility(event, worker);
  if (!roleCheck.ok) return roleCheck;

  return { ok: true };
}

export function formatMinutes(minutes = 0) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  let hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function dayName(day) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day];
}

function friendlyDate(dateString) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${dateString}T12:00:00`));
}

function workerNameFromAssignment(event, workerId) {
  const match = event.assignedWorkers?.find(a => String(a.worker?._id || a.worker) === String(workerId));
  return match?.worker?.name;
}
