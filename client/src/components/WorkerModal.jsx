import { useEffect, useState } from 'react';
import Modal from './Modal';

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function minutesToTime(minutes = 540) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function timeToMinutes(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return h * 60 + m;
}
function newRecurring() { return { dayOfWeek: 1, allDay: true, startMinutes: 540, endMinutes: 1020 }; }
function newTimeOff() {
  const today = new Date().toISOString().slice(0, 10);
  return { startDate: today, endDate: today, allDay: true, startMinutes: 540, endMinutes: 1020, reason: '' };
}

function parseRoles(value) {
  const seen = new Set();
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean).filter(role => {
    const key = role.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function WorkerModal({ worker, onClose, onSave, onDelete }) {
  const [name, setName] = useState('');
  const [maxWeeklyHours, setMaxWeeklyHours] = useState(25);
  const [rolesText, setRolesText] = useState('');
  const [recurring, setRecurring] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setName(worker?.name || '');
    setMaxWeeklyHours(worker?.maxWeeklyHours ?? 25);
    setRolesText((worker?.roles || []).join(', '));
    setRecurring((worker?.recurringUnavailable || []).map(x => ({ ...x })));
    setTimeOff((worker?.dateUnavailable || []).map(x => ({ ...x })));
  }, [worker]);

  function updateRecurring(index, patch) { setRecurring(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row)); }
  function updateTimeOff(index, patch) { setTimeOff(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row)); }

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const recurringUnavailable = recurring.map(row => ({
        dayOfWeek: Number(row.dayOfWeek), allDay: Boolean(row.allDay),
        ...(!row.allDay ? { startMinutes: Number(row.startMinutes), endMinutes: Number(row.endMinutes) } : {})
      }));
      const dateUnavailable = timeOff.map(row => ({
        startDate: row.startDate, endDate: row.endDate, allDay: Boolean(row.allDay), reason: row.reason || '',
        ...(!row.allDay ? { startMinutes: Number(row.startMinutes), endMinutes: Number(row.endMinutes) } : {})
      }));
      for (const row of recurringUnavailable) if (!row.allDay && row.startMinutes >= row.endMinutes) throw new Error('Recurring unavailable times must end after they start.');
      for (const row of dateUnavailable) {
        if (row.endDate < row.startDate) throw new Error('Time-off end date cannot be before its start date.');
        if (!row.allDay && row.startMinutes >= row.endMinutes) throw new Error('Time-off unavailable times must end after they start.');
      }
      await onSave({ name: name.trim(), maxWeeklyHours: Number(maxWeeklyHours), roles: parseRoles(rolesText), recurringUnavailable, dateUnavailable });
      onClose();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Delete ${worker.name}?`)) return;
    setBusy(true); setError('');
    try { await onDelete(worker._id); onClose(); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  const rolePreview = parseRoles(rolesText);

  return (
    <Modal title={worker ? 'Edit worker' : 'Add worker'} subtitle="Set roles, weekly limits, permanent restrictions, and temporary time off." onClose={onClose} wide>
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <div className="form-grid two">
          <label>Worker name<input value={name} onChange={e => setName(e.target.value)} placeholder="Alex Morgan" required /></label>
          <label>Max hours per week<input type="number" min="0.5" max="168" step="0.5" value={maxWeeklyHours} onChange={e => setMaxWeeklyHours(e.target.value)} required /></label>
        </div>
        <label>Roles <span className="label-hint">comma separated</span><input value={rolesText} onChange={e => setRolesText(e.target.value)} placeholder="Coach, Front Desk, Manager" /></label>
        {rolePreview.length > 0 && <div className="role-chip-row">{rolePreview.map(role => <span className="role-chip" key={role}>{role}</span>)}</div>}

        <div className="availability-section">
          <div className="section-heading-inline"><div><h3>Recurring unavailability</h3><p>Use this for rules that repeat every week.</p></div><button type="button" className="small-button" onClick={() => setRecurring(prev => [...prev, newRecurring()])}>+ Add restriction</button></div>
          {recurring.length === 0 && <div className="empty-rule">No recurring restrictions.</div>}
          {recurring.map((row, index) => (
            <div className="availability-row" key={row._id || index}>
              <select value={row.dayOfWeek} onChange={e => updateRecurring(index, { dayOfWeek: Number(e.target.value) })}>{days.map((day, i) => <option key={day} value={i}>{day}</option>)}</select>
              <label className="check-label"><input type="checkbox" checked={row.allDay} onChange={e => updateRecurring(index, { allDay: e.target.checked })} />All day</label>
              {!row.allDay && <>
                <input type="time" value={minutesToTime(row.startMinutes)} onChange={e => updateRecurring(index, { startMinutes: timeToMinutes(e.target.value) })} />
                <span>to</span>
                <input type="time" value={minutesToTime(row.endMinutes)} onChange={e => updateRecurring(index, { endMinutes: timeToMinutes(e.target.value) })} />
              </>}
              <button type="button" className="remove-row" onClick={() => setRecurring(prev => prev.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </div>

        <div className="availability-section">
          <div className="section-heading-inline"><div><h3>Time off / date-specific</h3><p>Use this for vacations, appointments, and one-off conflicts.</p></div><button type="button" className="small-button" onClick={() => setTimeOff(prev => [...prev, newTimeOff()])}>+ Add time off</button></div>
          {timeOff.length === 0 && <div className="empty-rule">No upcoming date-specific time off.</div>}
          {timeOff.map((row, index) => (
            <div className="timeoff-row" key={row._id || index}>
              <div className="timeoff-dates"><input type="date" value={row.startDate} onChange={e => updateTimeOff(index, { startDate: e.target.value, endDate: row.endDate < e.target.value ? e.target.value : row.endDate })} /><span>to</span><input type="date" value={row.endDate} onChange={e => updateTimeOff(index, { endDate: e.target.value })} /></div>
              <label className="check-label"><input type="checkbox" checked={row.allDay} onChange={e => updateTimeOff(index, { allDay: e.target.checked })} />All day</label>
              {!row.allDay && <div className="timeoff-times"><input type="time" value={minutesToTime(row.startMinutes)} onChange={e => updateTimeOff(index, { startMinutes: timeToMinutes(e.target.value) })} /><span>to</span><input type="time" value={minutesToTime(row.endMinutes)} onChange={e => updateTimeOff(index, { endMinutes: timeToMinutes(e.target.value) })} /></div>}
              <input className="reason-input" value={row.reason || ''} onChange={e => updateTimeOff(index, { reason: e.target.value })} placeholder="Reason (optional)" />
              <button type="button" className="remove-row" onClick={() => setTimeOff(prev => prev.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          {worker && <button className="danger-button" type="button" onClick={remove} disabled={busy}>Delete worker</button>}
          <span className="action-spacer" />
          <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save worker'}</button>
        </div>
      </form>
    </Modal>
  );
}
