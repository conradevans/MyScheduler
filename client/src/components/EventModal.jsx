import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';

function newRoleRequirement() { return { role: '', count: 1 }; }

export default function EventModal({ event, onClose, onSave, onDelete, availableRoles = [] }) {
  const [name, setName] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(120);
  const [workersNeeded, setWorkersNeeded] = useState(1);
  const [requiredRoles, setRequiredRoles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setName(event?.name || '');
    setDurationMinutes(event?.durationMinutes || 120);
    setWorkersNeeded(event?.workersNeeded || 1);
    setRequiredRoles((event?.requiredRoles || []).map(row => ({ ...row })));
  }, [event]);

  const roleOptions = useMemo(() => [...new Set(availableRoles.filter(Boolean))].sort((a, b) => a.localeCompare(b)), [availableRoles]);

  function updateRole(index, patch) {
    setRequiredRoles(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const cleanedRoles = requiredRoles.filter(row => row.role.trim()).map(row => ({ role: row.role.trim(), count: Number(row.count) }));
      const requiredTotal = cleanedRoles.reduce((sum, row) => sum + row.count, 0);
      if (requiredTotal > Number(workersNeeded)) throw new Error('Required role counts cannot exceed the total people needed.');
      await onSave({ name: name.trim(), durationMinutes: Number(durationMinutes), workersNeeded: Number(workersNeeded), requiredRoles: cleanedRoles });
      onClose();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Delete ${event.name}?`)) return;
    setBusy(true); setError('');
    try { await onDelete(event._id); onClose(); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title={event ? 'Edit event' : 'Add event'} subtitle="Saved events can be reused in any week. Add role requirements when a specific qualification must be present." onClose={onClose} wide>
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <label>Event name<input value={name} onChange={e => setName(e.target.value)} placeholder="Kids tennis class" required /></label>
        <div className="form-grid two">
          <label>Duration (minutes)<input type="number" min="1" max="1020" step="1" value={durationMinutes} onChange={e => setDurationMinutes(e.target.value)} required /></label>
          <label>People needed<input type="number" min="1" max="100" value={workersNeeded} onChange={e => setWorkersNeeded(e.target.value)} required /></label>
        </div>

        <div className="availability-section role-requirements-section">
          <div className="section-heading-inline">
            <div><h3>Required roles</h3><p>Optional. Example: require at least one Coach while the other positions can be any worker.</p></div>
            <button type="button" className="small-button" onClick={() => setRequiredRoles(prev => [...prev, newRoleRequirement()])}>+ Add role</button>
          </div>
          {requiredRoles.length === 0 && <div className="empty-rule">No specific role is required.</div>}
          <datalist id="event-role-options">{roleOptions.map(role => <option value={role} key={role} />)}</datalist>
          {requiredRoles.map((row, index) => (
            <div className="required-role-row" key={`${row.role}-${index}`}>
              <input list="event-role-options" value={row.role} onChange={e => updateRole(index, { role: e.target.value })} placeholder="Coach" />
              <span>Need</span>
              <input type="number" min="1" max={workersNeeded || 100} step="1" value={row.count} onChange={e => updateRole(index, { count: e.target.value })} />
              <button type="button" className="remove-row" onClick={() => setRequiredRoles(prev => prev.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          {event && <button className="danger-button" type="button" onClick={remove} disabled={busy}>Delete</button>}
          <span className="action-spacer" />
          <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</button>
        </div>
      </form>
    </Modal>
  );
}
