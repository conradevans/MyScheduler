import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import EventModal from '../components/EventModal';
import WorkerModal from '../components/WorkerModal';
import ScheduledEventTimeModal from '../components/ScheduledEventTimeModal';
import ScheduleTemplateModal from '../components/ScheduleTemplateModal';
import WorkplaceSettingsModal from '../components/WorkplaceSettingsModal';
import Modal from '../components/Modal';
import { addDays, formatDayHeader, formatTime, formatWeekRange, friendlyDate, parseDate, toDateString } from '../utils/dates';
import { shiftsWithSavedOpenings } from '../utils/shifts';

const START_MINUTES = 5 * 60;
const END_MINUTES = 22 * 60;
const ROW_HEIGHT = 120;
const SNAP_MINUTES = 5;
const TIMETABLE_HEIGHT = ((END_MINUTES - START_MINUTES) / 60) * ROW_HEIGHT;
const HOURS = Array.from({ length: 17 }, (_, i) => START_MINUTES + i * 60);
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function workerColorStyle(worker, dayWorkers = []) {
  const key = String(worker?._id || worker || 'worker');
  const workerIndex = dayWorkers.findIndex(item => String(item?._id || item) === key);
  const colorIndex = workerIndex >= 0 ? workerIndex : dayWorkers.length;
  const hue = Math.round((colorIndex * 137.508 + 218) % 360);
  return {
    '--worker-color': `hsl(${hue} 65% 47%)`,
    '--worker-soft': `hsl(${hue} 72% 95%)`,
    '--worker-ink': `hsl(${hue} 68% 31%)`
  };
}

function workHoursForDate(settings, date) {
  const dayOfWeek = parseDate(date).getDay();
  const day = settings?.dailyHours?.find(row => row.dayOfWeek === dayOfWeek);
  return {
    openMinutes: day?.openMinutes ?? settings.openMinutes,
    closeMinutes: day?.closeMinutes ?? settings.closeMinutes
  };
}

function minutesToInput(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function inputToMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return hours * 60 + minutes;
}

function dragPayload(e, payload) {
  e.dataTransfer.setData('application/json', JSON.stringify(payload));
  e.dataTransfer.effectAllowed = payload.type === 'worker' ? 'copy' : 'move';
}

function readDrag(e) {
  try { return JSON.parse(e.dataTransfer.getData('application/json')); }
  catch { return null; }
}

function recurringSummary(worker) {
  const rules = worker.recurringUnavailable || [];
  if (!rules.length) return 'No recurring restrictions';
  const first = rules[0];
  const label = first.allDay ? `${dayNames[first.dayOfWeek]} unavailable` : `${dayNames[first.dayOfWeek]} ${formatTime(first.startMinutes)}–${formatTime(first.endMinutes)}`;
  return rules.length > 1 ? `${label} +${rules.length - 1}` : label;
}

function upcomingSummary(worker) {
  const today = new Date().toISOString().slice(0, 10);
  const blocks = (worker.dateUnavailable || []).filter(x => x.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (!blocks.length) return null;
  const block = blocks[0];
  const date = block.startDate === block.endDate ? friendlyDate(block.startDate) : `${friendlyDate(block.startDate)}–${friendlyDate(block.endDate)}`;
  return block.reason ? `${date}: ${block.reason}` : date;
}

function roleSummary(requiredRoles = []) {
  if (!requiredRoles.length) return '';
  return requiredRoles.map(row => `${row.count} ${row.role}`).join(' · ');
}

function workerRoleLabel(worker) {
  return (worker?.roles || []).join(', ');
}

function roleFirstAssignments(assignments = []) {
  return [...assignments].sort((a, b) => {
    const aWorker = a.worker;
    const bWorker = b.worker;
    const roleDifference = Number(Boolean(workerRoleLabel(bWorker))) - Number(Boolean(workerRoleLabel(aWorker)));
    if (roleDifference) return roleDifference;
    return (aWorker?.name || '').localeCompare(bWorker?.name || '');
  });
}

function assignmentRangeLabel(assignment, event) {
  const start = assignment.startMinutes ?? event.startMinutes;
  const end = assignment.endMinutes ?? (event.startMinutes + event.durationMinutes);
  const wholeEvent = start === event.startMinutes && end === event.startMinutes + event.durationMinutes;
  return wholeEvent ? '' : `${formatTime(start)}–${formatTime(end)}`;
}


function shiftHours(shift) {
  return Math.max(0, (shift.endMinutes - shift.startMinutes) / 60);
}

function eventsCoveredByShift(shift, scheduled) {
  if (!shift.worker) return [];
  const workerId = String(shift.worker?._id || shift.worker || '');
  return scheduled.filter(event =>
    event.date === shift.date && (event.assignedWorkers || []).some(assignment => {
      const assignedId = String(assignment.worker?._id || assignment.worker || '');
      if (assignedId !== workerId) return false;
      const start = assignment.startMinutes ?? event.startMinutes;
      const end = assignment.endMinutes ?? (event.startMinutes + event.durationMinutes);
      return start < shift.endMinutes && end > shift.startMinutes;
    })
  );
}

export default function WeekScheduler() {
  const { weekStart } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [settings, setSettings] = useState({ openMinutes: 300, closeMinutes: 1320, shiftLengthHours: 4, shiftBlocks: [] });
  const [scheduleTemplates, setScheduleTemplates] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [eventModal, setEventModal] = useState(null);
  const [workerModal, setWorkerModal] = useState(null);
  const [workplaceModal, setWorkplaceModal] = useState(false);
  const [scheduledEventModal, setScheduledEventModal] = useState(null);
  const [scheduleTemplateModal, setScheduleTemplateModal] = useState(null);
  const [clearScheduleModal, setClearScheduleModal] = useState(null);
  const [clearingSchedule, setClearingSchedule] = useState(false);
  const [shiftDraft, setShiftDraft] = useState(null);
  const [savingShift, setSavingShift] = useState(false);
  const [shiftError, setShiftError] = useState('');
  const [shiftAssignment, setShiftAssignment] = useState(null);
  const [assigningShift, setAssigningShift] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');
  const [rosterDropDate, setRosterDropDate] = useState(null);
  const [message, setMessage] = useState(null);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showShiftRoster, setShowShiftRoster] = useState(true);
  const [workerSearch, setWorkerSearch] = useState('');
  const [workerRoleFilter, setWorkerRoleFilter] = useState('');
  const [dropPreview, setDropPreview] = useState(null);
  const suppressEventClickRef = useRef(false);

  const startDate = useMemo(() => parseDate(weekStart), [weekStart]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => toDateString(addDays(startDate, i))), [startDate]);
  const today = useMemo(() => toDateString(new Date()), []);
  const rosterShifts = useMemo(() => shiftsWithSavedOpenings(settings, days, shifts, today), [settings, days, shifts, today]);
  const availableRoles = useMemo(() => [...new Set(workers.flatMap(worker => worker.roles || []))].sort((a, b) => a.localeCompare(b)), [workers]);
  const filteredWorkers = useMemo(() => {
    const query = workerSearch.trim().toLocaleLowerCase();
    return workers.filter(worker => {
      const matchesName = !query || worker.name.toLocaleLowerCase().includes(query);
      const matchesRole = !workerRoleFilter || (worker.roles || []).some(role => role === workerRoleFilter);
      return matchesName && matchesRole;
    });
  }, [workers, workerSearch, workerRoleFilter]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [eventData, workerData, scheduleData, scheduleTemplateData] = await Promise.all([
        api('/api/events'),
        api('/api/workers'),
        api(`/api/schedule?weekStart=${encodeURIComponent(weekStart)}`),
        api('/api/schedule-templates')
      ]);
      setTemplates(eventData.events);
      setWorkers(workerData.workers);
      setScheduled(scheduleData.events);
      setShifts(scheduleData.shifts || []);
      setSettings(scheduleData.settings || { openMinutes: 300, closeMinutes: 1320, shiftLengthHours: 4, shiftBlocks: [] });
      setScheduleTemplates(scheduleTemplateData.templates || []);
      setStats(scheduleData.workerStats || {});
    } catch (err) {
      setMessage({ title: 'Could not load scheduler', body: err.message });
    } finally { setLoading(false); }
  }, [weekStart]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function saveEvent(payload) {
    const editing = eventModal?.event;
    const data = await api(editing ? `/api/events/${editing._id}` : '/api/events', {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    setTemplates(prev => editing ? prev.map(x => x._id === data.event._id ? data.event : x).sort((a,b)=>a.name.localeCompare(b.name)) : [...prev, data.event].sort((a,b)=>a.name.localeCompare(b.name)));
  }

  async function deleteEvent(id) {
    await api(`/api/events/${id}`, { method: 'DELETE' });
    setTemplates(prev => prev.filter(x => x._id !== id));
  }

  async function saveWorker(payload) {
    const editing = workerModal?.worker;
    const data = await api(editing ? `/api/workers/${editing._id}` : '/api/workers', {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    setWorkers(prev => editing ? prev.map(x => x._id === data.worker._id ? data.worker : x).sort((a,b)=>a.name.localeCompare(b.name)) : [...prev, data.worker].sort((a,b)=>a.name.localeCompare(b.name)));
  }

  async function deleteWorker(id) {
    await api(`/api/workers/${id}`, { method: 'DELETE' });
    setWorkers(prev => prev.filter(x => x._id !== id));
    await refreshSchedule();
  }

  async function saveWorkplaceSettings(payload) {
    const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    setSettings(data.settings);
    setMessage({
      title: 'Workplace settings saved',
      body: `Daily workplace hours and ${data.settings.shiftBlocks?.length || 0} saved shift${data.settings.shiftBlocks?.length === 1 ? '' : 's'} updated. Their requested positions now appear as gray open shifts on the roster until you or the generator assigns workers.`
    });
  }

  async function refreshSchedule() {
    const data = await api(`/api/schedule?weekStart=${encodeURIComponent(weekStart)}`);
    setScheduled(data.events);
    setShifts(data.shifts || []);
    setSettings(data.settings || settings);
    setStats(data.workerStats || {});
  }

  async function saveScheduledTime({ event, startMinutes }) {
    await api(`/api/schedule/${event._id}/position`, {
      method: 'PATCH',
      body: JSON.stringify({ date: event.date, startMinutes })
    });
    await refreshSchedule();
  }

  async function saveScheduleTemplate(payload) {
    const data = await api('/api/schedule-templates', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setScheduleTemplates(prev => [...prev, data.template].sort((a, b) => a.name.localeCompare(b.name)));
    setMessage({
      title: 'Template saved',
      body: `${data.template.name} saved ${data.template.events.length} event${data.template.events.length === 1 ? '' : 's'} and ${data.template.shifts?.length || 0} work shift${data.template.shifts?.length === 1 ? '' : 's'}.`
    });
  }

  async function deleteScheduleTemplate(id) {
    if (!window.confirm('Delete this saved schedule template? This will not remove any events already on the calendar.')) return;
    try {
      await api(`/api/schedule-templates/${id}`, { method: 'DELETE' });
      setScheduleTemplates(prev => prev.filter(template => template._id !== id));
    } catch (err) {
      setMessage({ title: 'Could not delete template', body: err.message });
    }
  }

  async function applyScheduleTemplate(payload) {
    const data = await api(`/api/schedule-templates/${payload.template._id}/apply`, {
      method: 'POST',
      body: JSON.stringify({
        copyWorkers: payload.copyWorkers,
        ...(payload.template.type === 'day' ? { targetDate: payload.targetDate } : { weekStart: payload.weekStart })
      })
    });

    if (data.destinationWeek === weekStart) await refreshSchedule();
    else navigate(`/week/${data.destinationWeek}`);

    const skipped = data.skippedAssignments || 0;
    const issueText = skipped
      ? ` ${skipped} worker item${skipped === 1 ? '' : 's'} could not be copied because of availability, another shift, weekly hours, role constraints, or a removed worker. ${data.issues.slice(0, 4).map(issue => `${issue.worker} → ${issue.event}: ${issue.reason}`).join(' | ')}${data.issues.length > 4 ? ' …' : ''}`
      : '';
    setMessage({
      title: skipped ? 'Schedule replaced with worker conflicts' : 'Schedule replaced',
      body: `Created ${data.eventsCreated} event${data.eventsCreated === 1 ? '' : 's'}${payload.copyWorkers ? `, copied ${data.copiedShifts || 0} work shift${data.copiedShifts === 1 ? '' : 's'}, and ${data.copiedAssignments} event assignment${data.copiedAssignments === 1 ? '' : 's'}` : ''}.${issueText}`
    });
  }

  async function clearSchedule() {
    if (!clearScheduleModal) return;
    setClearingSchedule(true);
    try {
      const isDay = clearScheduleModal.scope === 'day';
      const data = await api('/api/schedule/clear', {
        method: 'DELETE',
        body: JSON.stringify(isDay
          ? { scope: 'day', date: clearScheduleModal.date }
          : { scope: 'week', weekStart })
      });
      await refreshSchedule();
      setClearScheduleModal(null);
      setMessage({
        title: `${isDay ? 'Day' : 'Week'} cleared`,
        body: `Removed ${data.eventsDeleted} event${data.eventsDeleted === 1 ? '' : 's'} and ${data.shiftsDeleted} work shift${data.shiftsDeleted === 1 ? '' : 's'}.`
      });
    } catch (err) {
      setMessage({ title: 'Could not clear schedule', body: err.message });
    } finally {
      setClearingSchedule(false);
    }
  }

  function dropWorkerOnRoster(e, date) {
    e.preventDefault();
    setRosterDropDate(null);
    const payload = readDrag(e);
    if (payload?.type !== 'worker') return;
    const worker = workers.find(item => item._id === payload.id);
    if (!worker) return;
    if (shifts.some(shift => shift.date === date && String(shift.worker?._id || shift.worker) === String(worker._id))) {
      setMessage({ title: 'Worker already scheduled', body: `${worker.name} already has a shift on ${friendlyDate(date)}.` });
      return;
    }
    const hours = workHoursForDate(settings, date);
    const endMinutes = Math.min(hours.closeMinutes, hours.openMinutes + Math.round(settings.shiftLengthHours * 60));
    const availableShifts = (settings.shiftBlocks || [])
      .filter(block => block.dayOfWeek === parseDate(date).getDay())
      .map(block => {
        const assigned = shifts.filter(shift =>
          shift.date === date && (shift.worker
            ? shift.startMinutes <= block.startMinutes && shift.endMinutes >= block.endMinutes
            : shift.startMinutes === block.startMinutes && shift.endMinutes === block.endMinutes)
        ).length;
        return { ...block, remaining: Math.max(0, (block.workersNeeded ?? 1) - assigned) };
      })
      .filter(block => block.remaining > 0)
      .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
    setShiftError('');
    setShiftDraft({ worker, date, startMinutes: hours.openMinutes, endMinutes, availableShifts, custom: availableShifts.length === 0 });
  }

  function openCustomShiftDraft(date) {
    const hours = workHoursForDate(settings, date);
    const endMinutes = Math.min(hours.closeMinutes, hours.openMinutes + Math.round(settings.shiftLengthHours * 60));
    setShiftError('');
    setShiftDraft({ worker: null, date, startMinutes: hours.openMinutes, endMinutes, availableShifts: [], custom: true });
  }

  async function createRosterShift(selection = shiftDraft) {
    if (!selection) return;
    if (selection.endMinutes - selection.startMinutes < 180) {
      setShiftError('Shift must be at least three hours long.');
      return;
    }
    setSavingShift(true);
    setShiftError('');
    try {
      await api('/api/schedule/shifts', {
        method: 'POST',
        body: JSON.stringify({
          ...(selection.worker?._id ? { workerId: selection.worker._id } : {}),
          date: selection.date,
          startMinutes: selection.startMinutes,
          endMinutes: selection.endMinutes,
          locked: true
        })
      });
      setShiftDraft(null);
      await refreshSchedule();
    } catch (err) {
      setShiftError(err.message);
    } finally {
      setSavingShift(false);
    }
  }

  function openShiftAssignment(shift) {
    setAssignmentError('');
    setShiftAssignment({ shift, workerId: '' });
  }

  async function assignRosterShift(shift, workerId, { closeModal = true } = {}) {
    if (!workerId) {
      setAssignmentError('Choose a worker for this shift.');
      return;
    }
    setAssigningShift(true);
    setAssignmentError('');
    try {
      if (shift.isSavedPlaceholder) {
        await api('/api/schedule/shifts', {
          method: 'POST',
          body: JSON.stringify({
            workerId,
            date: shift.date,
            startMinutes: shift.startMinutes,
            endMinutes: shift.endMinutes,
            locked: true
          })
        });
      } else {
        await api(`/api/schedule/shifts/${shift._id}/worker`, {
          method: 'PATCH',
          body: JSON.stringify({ workerId })
        });
      }
      if (closeModal) setShiftAssignment(null);
      await refreshSchedule();
    } catch (err) {
      if (closeModal) setAssignmentError(err.message);
      else setMessage({ title: 'Worker unavailable', body: err.message });
    } finally {
      setAssigningShift(false);
    }
  }

  function dropWorkerOnOpenShift(e, shift) {
    e.preventDefault();
    e.stopPropagation();
    setRosterDropDate(null);
    const payload = readDrag(e);
    if (payload?.type !== 'worker') return;
    assignRosterShift(shift, payload.id, { closeModal: false });
  }

  async function toggleShiftLock(shift) {
    try {
      await api(`/api/schedule/shifts/${shift._id}/lock`, {
        method: 'PATCH',
        body: JSON.stringify({ locked: !shift.locked })
      });
      await refreshSchedule();
    } catch (err) {
      setMessage({ title: 'Could not update shift', body: err.message });
    }
  }

  async function removeRosterShift(shift) {
    try {
      await api(`/api/schedule/shifts/${shift._id}`, { method: 'DELETE' });
      await refreshSchedule();
    } catch (err) {
      setMessage({ title: 'Could not remove shift', body: err.message });
    }
  }

  function draggedDuration(payload) {
    if (payload?.type === 'event-template') return templates.find(x => x._id === payload.id)?.durationMinutes || 60;
    if (payload?.type === 'scheduled-event') return scheduled.find(x => x._id === payload.id)?.durationMinutes || 60;
    return 0;
  }

  function snappedStartFromPointer(e, durationMinutes) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const rawMinutes = START_MINUTES + (y / ROW_HEIGHT) * 60;
    const snapped = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
    const maxStart = Math.max(START_MINUTES, END_MINUTES - durationMinutes);
    return Math.max(START_MINUTES, Math.min(maxStart, snapped));
  }

  function timelineDragOver(e, date) {
    e.preventDefault();
    const payload = readDrag(e);
    if (!payload || (payload.type !== 'event-template' && payload.type !== 'scheduled-event')) {
      setDropPreview(null);
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    const durationMinutes = draggedDuration(payload);
    const startMinutes = snappedStartFromPointer(e, durationMinutes);
    setDropPreview({ date, startMinutes, durationMinutes });
  }

  async function dropOnTimeline(e, date) {
    e.preventDefault();
    const payload = readDrag(e);
    if (!payload || (payload.type !== 'event-template' && payload.type !== 'scheduled-event')) return;
    const durationMinutes = draggedDuration(payload);
    const startMinutes = snappedStartFromPointer(e, durationMinutes);
    setDropPreview(null);
    try {
      if (payload.type === 'event-template') {
        await api('/api/schedule', { method: 'POST', body: JSON.stringify({ templateId: payload.id, date, startMinutes }) });
      } else {
        await api(`/api/schedule/${payload.id}/position`, { method: 'PATCH', body: JSON.stringify({ date, startMinutes }) });
      }
      await refreshSchedule();
    } catch (err) {
      setMessage({ title: 'Could not place event', body: err.message });
    }
  }

  async function assignWorker(e, eventId) {
    const payload = readDrag(e);
    if (!payload || payload.type !== 'worker') return;
    e.preventDefault(); e.stopPropagation();
    try {
      await api(`/api/schedule/${eventId}/assign`, { method: 'POST', body: JSON.stringify({ workerId: payload.id }) });
      await refreshSchedule();
    } catch (err) {
      setMessage({ title: 'Worker unavailable', body: err.message });
    }
  }

  async function removeAssignment(eventId, workerId) {
    try { await api(`/api/schedule/${eventId}/assign/${workerId}`, { method: 'DELETE' }); await refreshSchedule(); }
    catch (err) { setMessage({ title: 'Could not remove assignment', body: err.message }); }
  }

  async function toggleLock(eventId, workerId, locked) {
    try {
      await api(`/api/schedule/${eventId}/assign/${workerId}/lock`, { method: 'PATCH', body: JSON.stringify({ locked }) });
      await refreshSchedule();
    } catch (err) { setMessage({ title: 'Could not update assignment', body: err.message }); }
  }

  async function deleteScheduled(id) {
    if (!window.confirm('Remove this event from the week? The saved event template will remain.')) return;
    try { await api(`/api/schedule/${id}`, { method: 'DELETE' }); await refreshSchedule(); }
    catch (err) { setMessage({ title: 'Could not remove event', body: err.message }); }
  }

  async function generateSchedule() {
    setGenerating(true);
    try {
      const data = await api('/api/schedule/auto-generate/run', { method: 'POST', body: JSON.stringify({ weekStart }) });
      setScheduled(data.events);
      setShifts(data.shifts || []);
      setAutoConfirm(false);
      await refreshSchedule();
      const issuePreview = data.issues.slice(0, 4).map(issue => issue.message).join(' | ');
      const filledOpenText = data.filledOpenShifts
        ? ` Filled ${data.filledOpenShifts} previously unassigned shift${data.filledOpenShifts === 1 ? '' : 's'}.`
        : '';
      const body = data.issues.length
        ? `Generated ${data.generatedShifts} work shifts and ${data.assignments} event coverage assignments.${filledOpenText} ${data.issues.length} coverage issue${data.issues.length === 1 ? '' : 's'} remain. ${issuePreview}${data.issues.length > 4 ? ' …' : ''}`
        : `Generated ${data.generatedShifts} work shifts using only your saved shift blocks, then assigned their workers to events.${filledOpenText}`;
      setMessage({ title: data.issues.length ? 'Schedule generated with issues' : 'Schedule generated', body });
    } catch (err) { setMessage({ title: 'Could not generate schedule', body: err.message }); }
    finally { setGenerating(false); }
  }

  function navigateWeek(delta) {
    navigate(`/week/${toDateString(addDays(startDate, delta * 7))}`);
  }

  async function doLogout() { await logout(); navigate('/login'); }

  const fullyStaffedEvents = scheduled.filter(event => event.coverage?.fullyStaffed ?? (event.assignedWorkers.length >= event.workersNeeded)).length;
  const unassignedShiftCount = rosterShifts.filter(shift => !shift.worker).length;
  const totalRoleRequirements = templates.reduce((sum, event) => sum + (event.requiredRoles?.length || 0), 0);

  return (
    <main className="scheduler-page">
      <header className="topbar scheduler-topbar">
        <div className="brand-lockup"><span className="brand-mark">M</span><span>MyScheduler</span></div>
        <div className="week-nav">
          <button className="icon-button square" onClick={() => navigateWeek(-1)}>‹</button>
          <div><span className="eyebrow">Week schedule</span><strong>{formatWeekRange(weekStart)}</strong></div>
          <button className="icon-button square" onClick={() => navigateWeek(1)}>›</button>
        </div>
        <div className="topbar-actions"><button className="ghost-button" onClick={() => navigate('/calendar')}>Month view</button><span className="user-chip">{user?.name}</span><button className="ghost-button" onClick={doLogout}>Log out</button></div>
      </header>

      <div className="scheduler-layout">
        <aside className="scheduler-sidebar">
          <div className="sidebar-actions">
            <button className="primary-button" onClick={() => setEventModal({ event: null })}>+ Add event</button>
            <button className="secondary-button" onClick={() => setWorkerModal({ worker: null })}>+ Add worker</button>
            <button className="ghost-button workplace-settings-button" onClick={() => setWorkplaceModal(true)}>⚙ Workplace hours & staffing</button>
          </div>
          <div className="workplace-summary-card">
            <div><span>Hours</span><strong>Set by day</strong></div>
            <div><span>Coverage</span><strong>Open to close</strong></div>
            <div><span>Saved shifts</span><strong>{settings.shiftBlocks?.length || 0} configured</strong></div>
            <div><span>Generator</span><strong>Saved shifts only</strong></div>
          </div>
          <div className="template-save-actions">
            <button className="ghost-button" onClick={() => setScheduleTemplateModal({ mode: 'save-day' })} disabled={scheduled.length === 0 && shifts.length === 0}>Save day</button>
            <button className="ghost-button" onClick={() => setScheduleTemplateModal({ mode: 'save-week' })} disabled={scheduled.length === 0 && shifts.length === 0}>Save week</button>
            <button className="danger-button" onClick={() => setClearScheduleModal({ scope: 'day', date: days.includes(toDateString(new Date())) ? toDateString(new Date()) : days[0] })} disabled={scheduled.length === 0 && shifts.length === 0}>Clear day</button>
            <button className="danger-button" onClick={() => setClearScheduleModal({ scope: 'week' })} disabled={scheduled.length === 0 && shifts.length === 0}>Clear week</button>
          </div>

          <section className="sidebar-section schedule-template-section">
            <div className="sidebar-section-head"><h2>Schedule templates</h2><span>{scheduleTemplates.length}</span></div>
            <p className="sidebar-help">Replace a day or week with a saved template. Worker shifts and event assignments are optional.</p>
            <div className="sidebar-list">
              {scheduleTemplates.length === 0 && <div className="sidebar-empty">Save a day or week to create your first schedule template.</div>}
              {scheduleTemplates.map(template => (
                <div className="schedule-template-card" key={template._id}>
                  <div>
                    <span className={`template-type-badge ${template.type}`}>{template.type}</span>
                    <strong>{template.name}</strong>
                    <small>{template.events.length} event{template.events.length === 1 ? '' : 's'} · {template.shifts?.length || 0} shift{template.shifts?.length === 1 ? '' : 's'}</small>
                  </div>
                  <div className="template-card-actions">
                    <button className="small-button" onClick={() => setScheduleTemplateModal({ mode: 'apply', template })}>Use</button>
                    <button className="mini-edit template-delete" title="Delete template" onClick={() => deleteScheduleTemplate(template._id)}>×</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-head"><h2>Events</h2><span>{templates.length}</span></div>
            <p className="sidebar-help">Drag an event onto a day and time. Required roles are enforced during assignment and auto-generation.</p>
            <div className="sidebar-list">
              {templates.length === 0 && <div className="sidebar-empty">Create your first reusable event.</div>}
              {templates.map(event => (
                <div className="event-template-card draggable-card" draggable onDragStart={e => dragPayload(e, { type: 'event-template', id: event._id })} onDragEnd={() => setDropPreview(null)} key={event._id}>
                  <div>
                    <strong>{event.name}</strong>
                    <span>{event.durationMinutes} min · {event.workersNeeded} worker{event.workersNeeded === 1 ? '' : 's'}</span>
                    {event.requiredRoles?.length > 0 && <span className="event-role-summary">Requires: {roleSummary(event.requiredRoles)}</span>}
                  </div>
                  <button className="mini-edit" onMouseDown={e => e.stopPropagation()} onClick={() => setEventModal({ event })}>Edit</button>
                </div>
              ))}
            </div>
          </section>

          <section className="sidebar-section workers-section">
            <div className="sidebar-section-head"><h2>Workers</h2><span>{filteredWorkers.length}</span></div>
            <p className="sidebar-help">Drag a worker onto an event or a gray open shift. If they are not already working that day, assigning an event creates one continuous shift near the standard target.</p>
            <div className="worker-filters">
              <label className="worker-search-field">
                <span aria-hidden="true">⌕</span>
                <input type="search" value={workerSearch} onChange={e => setWorkerSearch(e.target.value)} placeholder="Search workers" aria-label="Search workers by name" />
              </label>
              <select value={workerRoleFilter} onChange={e => setWorkerRoleFilter(e.target.value)} aria-label="Filter workers by role">
                <option value="">All roles</option>
                {availableRoles.map(role => <option value={role} key={role}>{role}</option>)}
              </select>
            </div>
            <div className="sidebar-list">
              {workers.length === 0 && <div className="sidebar-empty">Add workers to start staffing events.</div>}
              {workers.length > 0 && filteredWorkers.length === 0 && <div className="sidebar-empty">No workers match these filters.</div>}
              {filteredWorkers.map(worker => {
                const workerStats = stats[worker._id] || { currentHours: 0, previousHours: 0 };
                const upcoming = upcomingSummary(worker);
                return (
                  <div className="worker-card draggable-card" draggable onDragStart={e => dragPayload(e, { type: 'worker', id: worker._id })} key={worker._id}>
                    <div className="worker-card-top"><strong>{worker.name}</strong><button className="mini-edit" onMouseDown={e => e.stopPropagation()} onClick={() => setWorkerModal({ worker })}>Edit</button></div>
                    {worker.roles?.length > 0 && <div className="worker-role-list">{worker.roles.map(role => <span className="role-chip small" key={role}>{role}</span>)}</div>}
                    <div className="worker-hours"><span><b>{workerStats.currentHours.toFixed(1)}</b> / {worker.maxWeeklyHours} hrs this week</span><span>Last week {workerStats.previousHours.toFixed(1)} hrs</span></div>
                    <div className="worker-rule">{recurringSummary(worker)}</div>
                    {upcoming && <div className="worker-timeoff">Time off: {upcoming}</div>}
                  </div>
                );
              })}
            </div>
          </section>


        </aside>

        <section className="week-workspace">
          <div className="week-summary-bar">
            <div><span>{scheduled.length}</span> scheduled events</div>
            <div className={fullyStaffedEvents === scheduled.length && scheduled.length > 0 ? 'complete' : ''}><span>{fullyStaffedEvents}/{scheduled.length}</span> events fully staffed</div>
            <div className={unassignedShiftCount ? 'needs-attention' : ''}><span>{rosterShifts.length}</span> work shifts{unassignedShiftCount ? ` · ${unassignedShiftCount} open` : ''}</div>
            <div><span>{settings.shiftBlocks?.length || 0}</span> saved shifts · exact staffing counts</div>
          </div>

          <div className="shift-roster-board">
            <div className="shift-roster-title">
              <div>
                <span className="eyebrow">Staffing board</span>
                <strong>Daily shift roster</strong>
              </div>
              <div className="shift-roster-title-actions">
                <span>{settings.shiftBlocks?.length || 0} saved shift{settings.shiftBlocks?.length === 1 ? '' : 's'} · gray positions are waiting for workers</span>
                <button className="mini-edit" onClick={() => setShowShiftRoster(value => !value)}>{showShiftRoster ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            {showShiftRoster && <div className="shift-roster-grid">
              {days.map(date => {
                const header = formatDayHeader(date);
                const dayShifts = rosterShifts.filter(shift => shift.date === date).sort((a, b) => {
                  const timeDifference = a.startMinutes - b.startMinutes;
                  if (timeDifference) return timeDifference;
                  const roleDifference = Number(Boolean(workerRoleLabel(b.worker))) - Number(Boolean(workerRoleLabel(a.worker)));
                  return roleDifference || (a.worker?.name || '').localeCompare(b.worker?.name || '');
                });
                const dayWorkers = dayShifts.map(shift => shift.worker).filter(Boolean).filter((worker, index, list) => list.findIndex(item => String(item?._id || item) === String(worker?._id || worker)) === index);
                return (
                  <div
                    className={`shift-roster-day ${rosterDropDate === date ? 'drop-active' : ''}`}
                    key={`roster-${date}`}
                    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setRosterDropDate(date); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setRosterDropDate(null); }}
                    onDrop={e => dropWorkerOnRoster(e, date)}
                  >
                    <div className="shift-roster-day-head">
                      <strong>{header.weekday} {header.day}</strong>
                      <div className="shift-roster-day-tools">
                        <span>{dayShifts.length} shift{dayShifts.length === 1 ? '' : 's'}</span>
                        <button type="button" onClick={() => openCustomShiftDraft(date)} title={`Add an open shift on ${friendlyDate(date)}`}>+ Shift</button>
                      </div>
                    </div>
                    <div className="shift-roster-day-list">
                      {dayShifts.length === 0 && <div className="shift-roster-empty">No shifts</div>}
                      {dayShifts.map(shift => {
                        const coveredEvents = eventsCoveredByShift(shift, scheduled);
                        const unassigned = !shift.worker;
                        return (
                          <div
                            className={`roster-shift-card ${shift.locked ? 'locked' : ''} ${unassigned ? 'unassigned' : ''}`}
                            style={unassigned ? undefined : workerColorStyle(shift.worker, dayWorkers)}
                            key={shift._id}
                            onDragOver={unassigned ? e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } : undefined}
                            onDrop={unassigned ? e => dropWorkerOnOpenShift(e, shift) : undefined}
                          >
                            <div className="roster-shift-main">
                              <strong><span className="worker-color-dot" /><span className="roster-worker-name">{shift.worker?.name || 'Unassigned'}{workerRoleLabel(shift.worker) && <em>{workerRoleLabel(shift.worker)}</em>}</span></strong>
                              <span>{shiftHours(shift).toFixed(shiftHours(shift) % 1 ? 1 : 0)}h</span>
                            </div>
                            {shift.savedShiftName && <div className="roster-saved-shift-name">{shift.savedShiftName}</div>}
                            <div className="roster-shift-time">{formatTime(shift.startMinutes)}–{formatTime(shift.endMinutes)}</div>
                            {shift.worker?.roles?.length > 0 && <div className="roster-role-row">{shift.worker.roles.map(role => <span key={`${shift._id}-${role}`}>{role}</span>)}</div>}
                            {coveredEvents.length > 0 && <div className="roster-event-list">{coveredEvents.map(event => <span key={`${shift._id}-${event._id}`}>{event.name}</span>)}</div>}
                            <div className="roster-shift-footer">
                              <small>{unassigned ? shift.isSavedPlaceholder ? 'Saved shift · waiting for worker' : 'Open shift · generator can fill' : shift.locked ? 'Locked for generation' : shift.source === 'manual' ? 'Manual · unlocked' : 'Auto-generated'}</small>
                              <div className="roster-shift-actions">
                                {unassigned
                                  ? <button className="shift-assign-button" onClick={() => openShiftAssignment(shift)} title="Assign a worker to this shift">Assign</button>
                                  : <button className={`shift-lock-button ${shift.locked ? 'locked' : ''}`} onClick={() => toggleShiftLock(shift)} title={shift.locked ? 'Unlock shift' : 'Lock shift for generation'}>{shift.locked ? '🔒' : 'Lock'}</button>}
                                {!shift.isSavedPlaceholder && <button className="shift-remove-button" onClick={() => removeRosterShift(shift)} title={unassigned ? 'Remove open shift' : `Remove ${shift.worker.name}'s shift`}>×</button>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>}
          </div>

          {loading ? <div className="schedule-loading"><div className="spinner" /><span>Loading week…</span></div> : (
            <div className="timetable-card">
              <div className="timetable-header">
                <div className="time-header">Time</div>
                {days.map(date => {
                  const header = formatDayHeader(date);
                  return <div className="day-header" key={date}><span>{header.weekday}</span><strong>{header.day}</strong><small>{header.month}</small></div>;
                })}
              </div>

              <div className="timetable-scroll">
                <div className="timetable-body" style={{ height: TIMETABLE_HEIGHT }}>
                  <div className="time-axis" style={{ height: TIMETABLE_HEIGHT }}>
                    {HOURS.map(min => <div className="time-label" key={min}><span>{formatTime(min)}</span></div>)}
                    <div className="time-end-label">{formatTime(END_MINUTES)}</div>
                  </div>
                  {days.map(date => {
                    const dayShifts = rosterShifts
                      .filter(shift => shift.date === date)
                      .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || (a.worker?.name || '').localeCompare(b.worker?.name || ''));
                    const shiftStartBatches = [...new Set(dayShifts.map(shift => shift.startMinutes))];
                    const dayWorkers = dayShifts.map(shift => shift.worker).filter(Boolean).filter((worker, index, list) => list.findIndex(item => String(item?._id || item) === String(worker?._id || worker)) === index);
                    const dayHours = workHoursForDate(settings, date);
                    return (
                    <div
                      className="day-column"
                      style={{ height: TIMETABLE_HEIGHT }}
                      key={date}
                      onDragOver={e => timelineDragOver(e, date)}
                      onDrop={e => dropOnTimeline(e, date)}
                      onDragLeave={e => { const next = e.relatedTarget; if (!next || !e.currentTarget.contains(next)) setDropPreview(null); }}
                    >
                      <div className="closed-before" style={{ height: Math.max(0, ((dayHours.openMinutes - START_MINUTES) / 60) * ROW_HEIGHT) }} />
                      <div className="closed-after" style={{ top: ((dayHours.closeMinutes - START_MINUTES) / 60) * ROW_HEIGHT, bottom: 0 }} />
                      {HOURS.map(min => <div className="hour-drop-zone" key={min} />)}
                      <div className="shift-marker-layer" aria-hidden="true">
                        {dayShifts.map(shift => {
                          const unassigned = !shift.worker;
                          const top = ((shift.startMinutes - START_MINUTES) / 60) * ROW_HEIGHT;
                          const height = ((shift.endMinutes - shift.startMinutes) / 60) * ROW_HEIGHT;
                          const batchIndex = shiftStartBatches.indexOf(shift.startMinutes);
                          const batchShifts = dayShifts.filter(item => item.startMinutes === shift.startMinutes);
                          const workerIndex = batchShifts.indexOf(shift);
                          const batchPosition = shiftStartBatches.length === 1
                            ? 5
                            : 5 + (batchIndex * 72) / (shiftStartBatches.length - 1);
                          return <div className={`shift-marker ${shift.locked ? 'locked' : ''} ${unassigned ? 'unassigned' : ''}`} key={shift._id} style={{ ...(unassigned ? {} : workerColorStyle(shift.worker, dayWorkers)), top, height: Math.max(4, height), left: `calc(${batchPosition}% + ${workerIndex * 7}px)` }} title={`${shift.savedShiftName ? `${shift.savedShiftName} · ` : ''}${shift.worker?.name || 'Unassigned shift'} · ${formatTime(shift.startMinutes)}–${formatTime(shift.endMinutes)}`} />;
                        })}
                      </div>
                      {dropPreview?.date === date && (
                        <div
                          className="event-drop-preview"
                          style={{
                            top: ((dropPreview.startMinutes - START_MINUTES) / 60) * ROW_HEIGHT,
                            height: Math.max(2, (dropPreview.durationMinutes / 60) * ROW_HEIGHT - 2)
                          }}
                        >
                          <span>{formatTime(dropPreview.startMinutes)}</span>
                        </div>
                      )}
                      {scheduled.filter(event => event.date === date).map(event => {
                        const top = ((event.startMinutes - START_MINUTES) / 60) * ROW_HEIGHT;
                        const height = (event.durationMinutes / 60) * ROW_HEIGHT;
                        const understaffed = !(event.coverage?.fullyStaffed ?? (event.assignedWorkers.length >= event.workersNeeded));
                        const sizeClass = event.durationMinutes < 10 ? 'micro' : event.durationMinutes < 30 ? 'compact' : '';
                        const sortedAssignments = roleFirstAssignments(event.assignedWorkers).filter(a => a.worker);
                        const roster = sortedAssignments.map(a => `${a.worker.name}${workerRoleLabel(a.worker) ? ` (${workerRoleLabel(a.worker)})` : ''}`);
                        const rosterText = roster.length ? roster.join(', ') : 'No workers assigned';
                        return (
                          <div
                            className={`scheduled-event-block ${understaffed ? 'understaffed' : 'staffed'} ${sizeClass}`}
                            style={{ top, height: Math.max(2, height - 2) }}
                            title={`${event.name} · ${formatTime(event.startMinutes)}–${formatTime(event.startMinutes + event.durationMinutes)} · ${event.durationMinutes} min · ${rosterText}`}
                            draggable
                            onDragStart={e => {
                              suppressEventClickRef.current = true;
                              dragPayload(e, { type: 'scheduled-event', id: event._id });
                            }}
                            onDragEnd={() => {
                              setDropPreview(null);
                              window.setTimeout(() => { suppressEventClickRef.current = false; }, 0);
                            }}
                            onClick={() => {
                              if (!suppressEventClickRef.current) setScheduledEventModal(event);
                            }}
                            onDrop={e => assignWorker(e, event._id)}
                            key={event._id}
                          >
                            <div className="scheduled-event-head">
                              <div><strong>{event.name}</strong><span>{formatTime(event.startMinutes)}–{formatTime(event.startMinutes + event.durationMinutes)}</span></div>
                              <button className="event-remove" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); deleteScheduled(event._id); }}>×</button>
                            </div>
                            {event.requiredRoles?.length > 0 && <div className="event-required-role-line">Role: {roleSummary(event.requiredRoles)}</div>}
                            <div className="staff-count">{event.coverage?.minimumWorkersPresent ?? event.assignedWorkers.length}/{event.workersNeeded} minimum present{event.coverage && !event.coverage.rolesCovered ? ' · role missing' : ''}</div>
                            <div className="compact-roster-line">{rosterText}</div>
                            <div className="assignment-list">
                              {sortedAssignments.map((assignment, assignmentIndex) => {
                                const worker = assignment.worker;
                                if (!worker) return null;
                                const segment = assignmentRangeLabel(assignment, event);
                                return (
                                  <div className="assignment-pill" style={workerColorStyle(worker, dayWorkers)} key={`${worker._id}-${assignmentIndex}`} draggable={false}>
                                    <span>{worker.name}{workerRoleLabel(worker) ? ` · ${workerRoleLabel(worker)}` : ''}{segment ? ` · ${segment}` : ''}</span>
                                    <button title={assignment.locked ? 'Unlock for regeneration' : 'Lock assignment'} onClick={e => { e.stopPropagation(); toggleLock(event._id, worker._id, !assignment.locked); }}>{assignment.locked ? '🔒' : '○'}</button>
                                    <button title="Remove worker" onClick={e => { e.stopPropagation(); removeAssignment(event._id, worker._id); }}>×</button>
                                  </div>
                                );
                              })}
                            </div>
                            {understaffed && <div className="drop-worker-hint">Drop worker here</div>}
                            <div className="event-hover-card">
                              <strong>{event.name}</strong>
                              <span>{formatTime(event.startMinutes)}–{formatTime(event.startMinutes + event.durationMinutes)} · {event.durationMinutes} min</span>
                              {event.requiredRoles?.length > 0 && <span>Required: {roleSummary(event.requiredRoles)}</span>}
                              <div className="hover-roster">
                                {sortedAssignments.length === 0 ? <span>No workers assigned</span> : sortedAssignments.map((assignment, index) => <span key={`${assignment.worker?._id}-${index}`}>{assignment.worker?.name || 'Worker'}{workerRoleLabel(assignment.worker) ? ` · ${workerRoleLabel(assignment.worker)}` : ''}{assignmentRangeLabel(assignment, event) ? ` · ${assignmentRangeLabel(assignment, event)}` : ''}</span>)}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )})}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <button className="generate-button" onClick={() => setAutoConfirm(true)} disabled={generating || workers.length === 0}><span>✦</span> Generate schedule</button>

      {eventModal && <EventModal event={eventModal.event} availableRoles={availableRoles} onClose={() => setEventModal(null)} onSave={saveEvent} onDelete={deleteEvent} />}
      {scheduledEventModal && <ScheduledEventTimeModal event={scheduledEventModal} onClose={() => setScheduledEventModal(null)} onSave={saveScheduledTime} />}
      {workerModal && <WorkerModal worker={workerModal.worker} onClose={() => setWorkerModal(null)} onSave={saveWorker} onDelete={deleteWorker} />}
      {workplaceModal && <WorkplaceSettingsModal settings={settings} onClose={() => setWorkplaceModal(false)} onSave={saveWorkplaceSettings} />}
      {scheduleTemplateModal && <ScheduleTemplateModal
        mode={scheduleTemplateModal.mode}
        template={scheduleTemplateModal.template}
        days={days}
        weekStart={weekStart}
        onClose={() => setScheduleTemplateModal(null)}
        onSave={saveScheduleTemplate}
        onApply={applyScheduleTemplate}
      />}
      {clearScheduleModal && <Modal
        title={`Clear ${clearScheduleModal.scope}`}
        subtitle={`Permanently remove all events, work shifts, and assignments from this ${clearScheduleModal.scope}.`}
        onClose={() => !clearingSchedule && setClearScheduleModal(null)}
      >
        <div className="modal-form">
          {clearScheduleModal.scope === 'day' && <label>
            Day to clear
            <select value={clearScheduleModal.date} onChange={e => setClearScheduleModal(current => ({ ...current, date: e.target.value }))}>
              {days.map(date => <option value={date} key={date}>{friendlyDate(date)}</option>)}
            </select>
          </label>}
          <div className="clear-schedule-warning">
            This cannot be undone. Saved schedule templates will not be deleted, and gray shift openings from Workplace Settings will continue to appear until those settings are changed.
          </div>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setClearScheduleModal(null)} disabled={clearingSchedule}>Cancel</button>
            <span className="action-spacer" />
            <button className="danger-button" onClick={clearSchedule} disabled={clearingSchedule}>{clearingSchedule ? 'Clearing…' : `Clear ${clearScheduleModal.scope}`}</button>
          </div>
        </div>
      </Modal>}
      {shiftDraft && <Modal
        title={shiftDraft.worker ? `Add ${shiftDraft.worker.name} to shift roster` : 'Add an open custom shift'}
        subtitle={shiftDraft.worker
          ? `${friendlyDate(shiftDraft.date)} · Choose a saved shift or create a custom one. The shift will be locked automatically.`
          : `${friendlyDate(shiftDraft.date)} · Set the hours now and assign a worker later, or let the generator fill it.`}
        onClose={() => !savingShift && setShiftDraft(null)}
      >
        <div className="modal-form">
          {shiftError && <div className="form-error">{shiftError}</div>}
          {shiftDraft.availableShifts.length > 0 && <div className="available-shift-options">
            <span>Available saved shifts</span>
            {shiftDraft.availableShifts.map(block => <button
              type="button"
              className="available-shift-option"
              key={block._id || `${block.dayOfWeek}-${block.name}-${block.startMinutes}`}
              disabled={savingShift}
              onClick={() => createRosterShift({ ...shiftDraft, startMinutes: block.startMinutes, endMinutes: block.endMinutes })}
            >
              <strong>{block.name}</strong>
              <span>{formatTime(block.startMinutes)}–{formatTime(block.endMinutes)}</span>
              <small>{block.remaining} opening{block.remaining === 1 ? '' : 's'} · {block.workersNeeded ?? 1} people planned</small>
            </button>)}
          </div>}
          {!shiftDraft.custom && <button className="ghost-button custom-shift-toggle" type="button" onClick={() => setShiftDraft(current => ({ ...current, custom: true }))}>+ Add a custom shift instead</button>}
          {shiftDraft.custom && <>
            <div className="section-heading-inline"><div><strong>{shiftDraft.worker ? 'Custom shift' : 'Open shift hours'}</strong><p>Choose any time within this day’s workplace hours.</p></div></div>
            <div className="form-grid two">
              <label>Shift starts<input type="time" value={minutesToInput(shiftDraft.startMinutes)} onChange={e => setShiftDraft(current => ({ ...current, startMinutes: inputToMinutes(e.target.value) }))} /></label>
              <label>Shift ends<input type="time" value={minutesToInput(shiftDraft.endMinutes)} onChange={e => setShiftDraft(current => ({ ...current, endMinutes: inputToMinutes(e.target.value) }))} /></label>
            </div>
          </>}
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setShiftDraft(null)} disabled={savingShift}>Cancel</button>
            <span className="action-spacer" />
            {shiftDraft.custom && <button className="primary-button" onClick={() => createRosterShift()} disabled={savingShift}>{savingShift ? 'Adding…' : shiftDraft.worker ? 'Add & lock custom shift' : 'Add open shift'}</button>}
          </div>
        </div>
      </Modal>}
      {shiftAssignment && <Modal
        title="Assign open shift"
        subtitle={`${shiftAssignment.shift.savedShiftName ? `${shiftAssignment.shift.savedShiftName} · ` : ''}${friendlyDate(shiftAssignment.shift.date)} · ${formatTime(shiftAssignment.shift.startMinutes)}–${formatTime(shiftAssignment.shift.endMinutes)}`}
        onClose={() => !assigningShift && setShiftAssignment(null)}
      >
        <div className="modal-form">
          {assignmentError && <div className="form-error">{assignmentError}</div>}
          <label>
            Worker
            <select value={shiftAssignment.workerId} onChange={e => setShiftAssignment(current => ({ ...current, workerId: e.target.value }))} autoFocus>
              <option value="">Choose a worker…</option>
              {workers
                .filter(worker => !shifts.some(shift => shift.date === shiftAssignment.shift.date && shift.worker && String(shift.worker?._id || shift.worker) === String(worker._id)))
                .map(worker => <option value={worker._id} key={worker._id}>{worker.name}{workerRoleLabel(worker) ? ` · ${workerRoleLabel(worker)}` : ''}</option>)}
            </select>
            <small className="field-help">Availability and weekly-hour limits are checked before assignment.</small>
          </label>
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => setShiftAssignment(null)} disabled={assigningShift}>Cancel</button>
            <span className="action-spacer" />
            <button className="primary-button" onClick={() => assignRosterShift(shiftAssignment.shift, shiftAssignment.workerId)} disabled={assigningShift}>{assigningShift ? 'Assigning…' : 'Assign worker'}</button>
          </div>
        </div>
      </Modal>}
      {message && <Modal title={message.title} onClose={() => setMessage(null)}><div className="message-body"><p>{message.body}</p><div className="modal-actions"><span className="action-spacer" /><button className="primary-button" onClick={() => setMessage(null)}>Close</button></div></div></Modal>}
      {autoConfirm && <Modal title="Generate work shifts & event staffing" subtitle="MyScheduler will fill gray saved/custom openings, then rebuild unlocked generated shifts and event assignments for this week." onClose={() => !generating && setAutoConfirm(false)}>
        <div className="generator-checks">
          <div>✓ Fill gray open shifts</div><div>✓ Saved shifts only</div><div>✓ Exact worker count per shift</div><div>✓ One continuous shift per worker/day</div><div>✓ No extra gap-filling shifts</div><div>✓ Worker roles</div><div>✓ Event role requirements</div><div>✓ Recurring availability</div><div>✓ Date-specific time off</div><div>✓ Weekly hour limits</div><div>✓ Previous-week fairness</div>
        </div>
        <p className="muted generator-note">Locked/manual choices stay in place. The generator creates realistic continuous workplace shifts near the standard target, adjusting handoffs when that prevents unnecessary overlap. It then assigns workers who are already on-site to events, preferring continuity and only handing an event off when an actual shift ends.</p>
        <div className="modal-actions"><button className="ghost-button" onClick={() => setAutoConfirm(false)} disabled={generating}>Cancel</button><span className="action-spacer" /><button className="primary-button" onClick={generateSchedule} disabled={generating}>{generating ? 'Generating…' : 'Generate schedule'}</button></div>
      </Modal>}
    </main>
  );
}
