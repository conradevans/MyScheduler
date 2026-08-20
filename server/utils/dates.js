export const SCHEDULE_START = 5 * 60;
export const SCHEDULE_END = 22 * 60;

export function parseDate(dateString) {
  return new Date(`${dateString}T12:00:00`);
}

export function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(dateString, amount) {
  const date = parseDate(dateString);
  date.setDate(date.getDate() + amount);
  return toDateString(date);
}

export function mondayOf(dateString) {
  const date = parseDate(dateString);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return toDateString(date);
}

export function getWeekRange(weekStart) {
  const monday = mondayOf(weekStart);
  return { start: monday, end: addDays(monday, 6) };
}

export function getDayOfWeek(dateString) {
  return parseDate(dateString).getDay();
}

export function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}
