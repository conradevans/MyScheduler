import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { formatMonthTitle, getMonthWeeks, toDateString } from '../utils/dates';

const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Calendar() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [cursor, setCursor] = useState(() => new Date());
  const weeks = useMemo(() => getMonthWeeks(cursor.getFullYear(), cursor.getMonth()), [cursor]);
  const today = toDateString(new Date());

  function moveMonth(delta) {
    setCursor(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }

  async function doLogout() { await logout(); navigate('/login'); }

  return (
    <main className="calendar-page">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">M</span><span>MyScheduler</span></div>
        <div className="topbar-actions"><span className="user-chip">{user?.name}</span><button className="ghost-button" onClick={doLogout}>Log out</button></div>
      </header>

      <section className="calendar-shell">
        <div className="calendar-title-row">
          <div><span className="eyebrow">Monthly view</span><h1>{formatMonthTitle(cursor)}</h1><p>Click any week row to open its scheduler.</p></div>
          <div className="calendar-controls">
            <button className="icon-button square" onClick={() => moveMonth(-1)}>‹</button>
            <button className="ghost-button" onClick={() => setCursor(new Date())}>Today</button>
            <button className="icon-button square" onClick={() => moveMonth(1)}>›</button>
          </div>
        </div>

        <div className="month-calendar">
          <div className="month-weekdays">{dayNames.map(day => <div key={day}>{day}</div>)}</div>
          {weeks.map((week, index) => (
            <button className="month-week-row" key={index} onClick={() => navigate(`/week/${toDateString(week[0])}`)}>
              {week.map(date => {
                const value = toDateString(date);
                const outside = date.getMonth() !== cursor.getMonth();
                return (
                  <div className={`month-day ${outside ? 'outside' : ''} ${value === today ? 'today' : ''}`} key={value}>
                    <span>{date.getDate()}</span>
                    {value === today && <small>Today</small>}
                  </div>
                );
              })}
              <span className="week-row-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
