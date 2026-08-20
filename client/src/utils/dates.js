export function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDate(value) {
  return new Date(`${value}T12:00:00`);
}

export function addDays(value, amount) {
  const d = typeof value === 'string' ? parseDate(value) : new Date(value);
  d.setDate(d.getDate() + amount);
  return d;
}

export function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

export function getMonthWeeks(year, month) {
  const first = new Date(year, month, 1, 12);
  const last = new Date(year, month + 1, 0, 12);
  let cursor = mondayOf(first);
  const weeks = [];
  while (cursor <= last) {
    const week = [];
    for (let i = 0; i < 7; i++) week.push(addDays(cursor, i));
    weeks.push(week);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function formatMonthTitle(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date);
}

export function formatWeekRange(weekStart) {
  const start = typeof weekStart === 'string' ? parseDate(weekStart) : new Date(weekStart);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const left = new Intl.DateTimeFormat('en-US', sameMonth ? { month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric' }).format(start);
  const right = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(end);
  return `${left} – ${right}`;
}

export function formatDayHeader(dateString) {
  const date = parseDate(dateString);
  return {
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date),
    day: date.getDate(),
    month: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date)
  };
}

export function formatTime(minutes) {
  let hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${suffix}`;
}

export function friendlyDate(value) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parseDate(value));
}
