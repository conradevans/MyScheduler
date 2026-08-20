import { useMemo, useState } from 'react';
import Modal from './Modal';
import { formatWeekRange, friendlyDate } from '../utils/dates';

export default function ScheduleTemplateModal({ mode, template, days = [], weekStart, onClose, onSave, onApply }) {
  const [name, setName] = useState('');
  const [sourceDate, setSourceDate] = useState(days[0] || weekStart);
  const [targetDate, setTargetDate] = useState(weekStart);
  const [copyWorkers, setCopyWorkers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const title = useMemo(() => {
    if (mode === 'save-day') return 'Save day template';
    if (mode === 'save-week') return 'Save week template';
    return `Use ${template?.name || 'template'}`;
  }, [mode, template]);

  const subtitle = mode === 'apply'
    ? `Replace a destination ${template?.type || ''} with this template.`
    : 'Save the scheduled events and work shifts so you can reuse the schedule later.';

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (mode === 'save-day') {
        await onSave({ name, type: 'day', sourceDate });
      } else if (mode === 'save-week') {
        await onSave({ name, type: 'week', weekStart });
      } else {
        await onApply({
          template,
          copyWorkers,
          ...(template.type === 'day' ? { targetDate } : { weekStart: targetDate })
        });
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}

        {mode !== 'apply' && (
          <label>
            Template name
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={mode === 'save-day' ? 'Friday dinner schedule' : 'Typical work week'}
              maxLength={80}
              required
              autoFocus
            />
          </label>
        )}

        {mode === 'save-day' && (
          <label>
            Day to save
            <select value={sourceDate} onChange={e => setSourceDate(e.target.value)}>
              {days.map(date => <option value={date} key={date}>{friendlyDate(date)}</option>)}
            </select>
          </label>
        )}

        {mode === 'save-week' && (
          <div className="template-source-summary">
            <span>Saving current week</span>
            <strong>{formatWeekRange(weekStart)}</strong>
            <small>All scheduled events, work shifts, and current event assignments are stored in the template.</small>
          </div>
        )}

        {mode === 'apply' && (
          <>
            <label>
              {template.type === 'day' ? 'Replace date' : 'Replace week starting'}
              <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} required />
              {template.type === 'week' && <small className="field-help">Choose the Monday of the destination week.</small>}
            </label>

            <label className="template-copy-workers">
              <input type="checkbox" checked={copyWorkers} onChange={e => setCopyWorkers(e.target.checked)} />
              <span>
                <strong>Copy workers and shifts</strong>
                <small>Copied work shifts and event assignments are revalidated for availability, time off, overlaps, weekly hour limits, and role requirements. Invalid worker placements are skipped rather than forced onto the schedule.</small>
              </span>
            </label>

            <div className="template-apply-note">
              This replaces the entire destination {template.type}. All existing events, work shifts, and assignments there will be removed first—even on empty days in a week template.
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <div className="action-spacer" />
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? 'Working…' : mode === 'apply' ? `Replace ${template.type}` : 'Save template'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
