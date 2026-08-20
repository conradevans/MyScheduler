import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/calendar" replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      navigate('/calendar');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel auth-brand-panel">
        <div className="brand-lockup"><span className="brand-mark">M</span><span>MyScheduler</span></div>
        <div className="auth-copy">
          <span className="eyebrow">Smarter weekly staffing</span>
          <h1>Build fair schedules without fighting a spreadsheet.</h1>
          <p>Place events, manage worker availability, and generate balanced weekly assignments in seconds.</p>
        </div>
        <div className="auth-feature-strip">
          <span>Availability aware</span><span>Fair hour distribution</span><span>Drag & drop</span>
        </div>
      </section>

      <section className="auth-panel auth-form-panel">
        <form className="auth-form" onSubmit={submit}>
          <div>
            <span className="eyebrow">Welcome back</span>
            <h2>Log in to MyScheduler</h2>
            <p className="muted">Your teams, events, and saved schedules are waiting.</p>
          </div>
          {error && <div className="form-error">{error}</div>}
          <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" /></label>
          <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required autoComplete="current-password" /></label>
          <button className="primary-button auth-submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
          <p className="auth-switch">Don’t have an account? <Link to="/register">Create account</Link></p>
        </form>
      </section>
    </main>
  );
}
