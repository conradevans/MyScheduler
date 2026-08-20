import { parseDate } from './dates.js';

export function shiftsWithSavedOpenings(settings, days, shifts, today) {
  const decorated = shifts.map(shift => {
    const matchingBlock = (settings?.shiftBlocks || []).find(block =>
      block.dayOfWeek === parseDate(shift.date).getDay() &&
      (shift.worker
        ? shift.startMinutes <= block.startMinutes && shift.endMinutes >= block.endMinutes
        : shift.startMinutes === block.startMinutes && shift.endMinutes === block.endMinutes)
    );
    return matchingBlock ? { ...shift, savedShiftName: matchingBlock.name } : shift;
  });
  const placeholders = [];

  for (const date of days) {
    if (today && date < today) continue;
    const dayOfWeek = parseDate(date).getDay();
    const blocks = (settings?.shiftBlocks || []).filter(block => block.dayOfWeek === dayOfWeek);
    for (const block of blocks) {
      const existingCount = shifts.filter(shift =>
        shift.date === date &&
        (shift.worker
          ? shift.startMinutes <= block.startMinutes && shift.endMinutes >= block.endMinutes
          : shift.startMinutes === block.startMinutes && shift.endMinutes === block.endMinutes)
      ).length;
      const missing = Math.max(0, Number(block.workersNeeded ?? 1) - existingCount);
      for (let index = 0; index < missing; index++) {
        placeholders.push({
          _id: `saved-open-${block._id || `${dayOfWeek}-${block.startMinutes}-${block.endMinutes}`}-${date}-${existingCount + index}`,
          worker: null,
          date,
          startMinutes: block.startMinutes,
          endMinutes: block.endMinutes,
          locked: true,
          preserveSlot: true,
          source: 'settings',
          isSavedPlaceholder: true,
          savedShiftName: block.name
        });
      }
    }
  }

  return [...decorated, ...placeholders];
}
