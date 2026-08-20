import { useEffect, useState } from 'react';
import Modal from './Modal';

function minutesToTime(minutes = 300) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return h * 60 + m;
}

const dayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function WorkplaceSettingsModal({ settings, onClose, onSave }) {
  const [dailyHours, setDailyHours] = useState([]);
  const [shiftBlocks, setShiftBlocks] = useState([]);
  const [shiftLengthHours, setShiftLengthHours] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDailyHours(dayLabels.map((_, dayOfWeek) => {
      const saved = settings?.dailyHours?.find(row => row.dayOfWeek === dayOfWeek);
      return {
        dayOfWeek,
        openTime: minutesToTime(saved?.openMinutes ?? settings?.openMinutes ?? 300),
        closeTime: minutesToTime(saved?.closeMinutes ?? settings?.closeMinutes ?? 1320)
      };
    }));
    setShiftBlocks((settings?.shiftBlocks || []).map((block, index) => ({
      key: block._id || `${block.dayOfWeek}-${index}`,
      dayOfWeek: block.dayOfWeek,
      name: block.name,
      startTime: minutesToTime(block.startMinutes),
      endTime: minutesToTime(block.endMinutes),
      workersNeeded: block.workersNeeded ?? 1
    })));
    setShiftLengthHours(settings?.shiftLengthHours ?? 4);
  }, [settings]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const normalizedHours = dailyHours.map(row => ({
        dayOfWeek: row.dayOfWeek,
        openMinutes: timeToMinutes(row.openTime),
        closeMinutes: timeToMinutes(row.closeTime)
      }));
      const normalizedShifts = shiftBlocks.map(block => ({
        dayOfWeek: block.dayOfWeek,
        name: block.name.trim(),
        startMinutes: timeToMinutes(block.startTime),
        endMinutes: timeToMinutes(block.endTime),
        workersNeeded: Number(block.workersNeeded)
      }));
      if (normalizedHours.some(row => row.closeMinutes <= row.openMinutes)) throw new Error('Each closing time must be later than its opening time.');
      const shiftKeys = normalizedShifts.map(block => `${block.dayOfWeek}:${block.startMinutes}:${block.endMinutes}`);
      if (new Set(shiftKeys).size !== shiftKeys.length) throw new Error('Combine saved shifts with the same day and times into one row and increase its People count.');
      await onSave({
        openMinutes: normalizedHours[1].openMinutes,
        closeMinutes: normalizedHours[1].closeMinutes,
        dailyHours: normalizedHours,
        shiftBlocks: normalizedShifts,
        shiftLengthHours: Number(shiftLengthHours)
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Workplace settings" subtitle="Set each day's hours and the shifts that should appear on the staffing roster." onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <div className="daily-hours-grid">
          {dailyHours.map((row, index) => <div className="daily-settings-day" key={row.dayOfWeek}>
            <div className="daily-hours-row">
              <strong>{dayLabels[row.dayOfWeek]}</strong>
              <label>Open<input type="time" min="05:00" max="21:59" value={row.openTime} onChange={e => setDailyHours(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, openTime: e.target.value } : item))} required /></label>
              <label>Close<input type="time" min="05:01" max="22:00" value={row.closeTime} onChange={e => setDailyHours(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, closeTime: e.target.value } : item))} required /></label>
              <button className="mini-edit" type="button" onClick={() => setShiftBlocks(current => [...current, { key: `${row.dayOfWeek}-${Date.now()}`, dayOfWeek: row.dayOfWeek, name: 'Shift', startTime: row.openTime, endTime: row.closeTime, workersNeeded: 1 }])}>+ Shift</button>
            </div>
            {shiftBlocks.filter(block => block.dayOfWeek === row.dayOfWeek).map(block => <div className="saved-shift-row" key={block.key}>
              <input value={block.name} maxLength={40} aria-label="Shift name" onChange={e => setShiftBlocks(current => current.map(item => item.key === block.key ? { ...item, name: e.target.value } : item))} required />
              <input type="time" value={block.startTime} aria-label="Shift start" onChange={e => setShiftBlocks(current => current.map(item => item.key === block.key ? { ...item, startTime: e.target.value } : item))} required />
              <input type="time" value={block.endTime} aria-label="Shift end" onChange={e => setShiftBlocks(current => current.map(item => item.key === block.key ? { ...item, endTime: e.target.value } : item))} required />
              <label className="shift-worker-count">People<input type="number" min="0" max="100" step="1" value={block.workersNeeded} onChange={e => setShiftBlocks(current => current.map(item => item.key === block.key ? { ...item, workersNeeded: e.target.value } : item))} required /></label>
              <button className="remove-row" type="button" title="Remove saved shift" onClick={() => setShiftBlocks(current => current.filter(item => item.key !== block.key))}>×</button>
            </div>)}
          </div>)}
        </div>
        <div className="form-grid">
          <label>Default manual shift length (hours)<input type="number" min="3" max="16" step="0.5" value={shiftLengthHours} onChange={e => setShiftLengthHours(e.target.value)} required /></label>
        </div>
        <div className="settings-explainer">
          Each requested position appears immediately as a gray open shift on that week's roster. You can assign workers yourself or let the generator fill them; it will not add shifts beyond these saved positions.
        </div>
        <div className="modal-actions">
          <span className="action-spacer" />
          <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>
    </Modal>
  );
}
