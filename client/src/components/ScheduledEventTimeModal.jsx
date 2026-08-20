import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import { formatTime, friendlyDate } from '../utils/dates';

const SCHEDULE_START = 5 * 60;
const SCHEDULE_END = 22 * 60;

function minutesToInput(minutes) {
  const safe = Math.max(0, Math.min(23 * 60 + 59, Number(minutes) || 0));
  const hours = String(Math.floor(safe / 60)).padStart(2, '0');
  const mins = String(safe % 60).padStart(2, '0');
  return `${hours}:${mins}`;
}

function inputToMinutes(value) {
  const [hours, mins] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return null;
  return hours * 60 + mins;
}

export default function ScheduledEventTimeModal({ event, onClose, onSave }) {
  const [startMinutes, setStartMinutes] = useState(event.startMinutes);
  const [endMinutes, setEndMinutes] = useState(event.startMinutes + event.durationMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setStartMinutes(event.startMinutes);
    setEndMinutes(event.startMinutes + event.durationMinutes);
    setError('');
  }, [event]);

  const validation = useMemo(() => {
    if (startMinutes < SCHEDULE_START) return 'Start time cannot be earlier than 5:00 AM.';
    if (endMinutes > SCHEDULE_END) return 'End time cannot be later than 10:00 PM.';
    if (endMinutes - startMinutes !== event.durationMinutes) return 'Start and end must preserve the saved event duration.';
    return '';
  }, [startMinutes, endMinutes, event.durationMinutes]);

  function changeStart(value) {
    const nextStart = inputToMinutes(value);
    if (nextStart === null) return;
    setStartMinutes(nextStart);
    setEndMinutes(nextStart + event.durationMinutes);
    setError('');
  }

  function changeEnd(value) {
    const nextEnd = inputToMinutes(value);
    if (nextEnd === null) return;
    setEndMinutes(nextEnd);
    setStartMinutes(nextEnd - event.durationMinutes);
    setError('');
  }

  async function submit(e) {
    e.preventDefault();
    if (validation) {
      setError(validation);
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onSave({ event, startMinutes });
      onClose();
    } catch (err) {
      setError(err.message || 'Could not update event time.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${event.name}`}
      subtitle={`${friendlyDate(event.date)} · Duration stays fixed at ${event.durationMinutes} minutes.`}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        {(error || validation) && <div className="form-error">{error || validation}</div>}

        <div className="scheduled-time-summary">
          <span>Current duration</span>
          <strong>{event.durationMinutes} min</strong>
          <small>{formatTime(startMinutes)} – {formatTime(endMinutes)}</small>
        </div>

        <div className="form-grid two scheduled-time-grid">
          <label>
            Start time
            <input
              type="time"
              step="60"
              min="05:00"
              max="22:00"
              value={minutesToInput(startMinutes)}
              onChange={e => changeStart(e.target.value)}
              required
            />
            <small>Changing this automatically moves the end time.</small>
          </label>
          <label>
            End time
            <input
              type="time"
              step="60"
              min="05:00"
              max="22:00"
              value={minutesToInput(endMinutes)}
              onChange={e => changeEnd(e.target.value)}
              required
            />
            <small>Changing this automatically moves the start time.</small>
          </label>
        </div>

        <p className="scheduled-time-note">
          Exact minute entry is allowed here. Dragging on the timetable still snaps to 5-minute increments for quick placement.
        </p>

        <div className="modal-actions">
          <span className="action-spacer" />
          <button className="ghost-button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-button" disabled={busy || Boolean(validation)}>{busy ? 'Saving…' : 'Save time'}</button>
        </div>
      </form>
    </Modal>
  );
}
