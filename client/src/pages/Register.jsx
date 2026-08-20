import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/calendar" replace />;

  function update(key, value) { setForm(prev => ({ ...prev, [key]: value })); }

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true); setError('');
    try {
      await register(form.name, form.email, form.password);
      navigate('/calendar');
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel auth-brand-panel">
        <div className="brand-lockup"><span className="brand-mark">M</span><span>MyScheduler</span></div>
        <div className="auth-copy">
          <span className="eyebrow">Set up your workspace</span>
          <h1>Your scheduling system, built around your people.</h1>
          <p>Create workers once, save recurring events, and let MyScheduler handle the hard constraints.</p>
        </div>
        <div className="auth-feature-strip"><span>Encrypted passwords</span><span>Persistent MongoDB data</span><span>Week-by-week control</span></div>
      </section>

      <section className="auth-panel auth-form-panel">
        <form className="auth-form" onSubmit={submit}>
          <div><span className="eyebrow">Get started</span><h2>Create your account</h2><p className="muted">You can add your workers and events right after signup.</p></div>
          {error && <div className="form-error">{error}</div>}
          <label>Name<input value={form.name} onChange={e => update('name', e.target.value)} placeholder="Your name" required autoComplete="name" /></label>
          <label>Email<input type="email" value={form.email} onChange={e => update('email', e.target.value)} placeholder="you@example.com" required autoComplete="email" /></label>
          <label>Password<input type="password" value={form.password} onChange={e => update('password', e.target.value)} placeholder="At least 8 characters" required autoComplete="new-password" /></label>
          <label>Confirm password<input type="password" value={form.confirm} onChange={e => update('confirm', e.target.value)} placeholder="Repeat password" required autoComplete="new-password" /></label>
          <button className="primary-button auth-submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
          <p className="auth-switch">Already have an account? <Link to="/login">Log in</Link></p>
        </form>
      </section>
    </main>
  );
}
