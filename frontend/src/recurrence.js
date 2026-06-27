const pad = (value) => String(value).padStart(2, '0');

export const toKey = (date) => {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}-${month}-${day}`;
};

export const toTimeKey = (date) => {
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${hours}:${minutes}`;
};

const parseKey = (value) => new Date(`${value}T00:00:00`);

const diffInDays = (startKey, endKey) => {
  const difference = parseKey(endKey).getTime() - parseKey(startKey).getTime();
  return Math.floor(difference / 86400000);
};

const monthsBetween = (startKey, endKey) => {
  const start = parseKey(startKey);
  const end = parseKey(endKey);
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
};

export const buildCalendarDays = (date) => {
  const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const leadingEmptyCells = firstDay.getDay();
  const totalDays = lastDay.getDate();
  const cells = [];

  for (let index = 0; index < leadingEmptyCells; index += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= totalDays; day += 1) {
    cells.push(new Date(date.getFullYear(), date.getMonth(), day));
  }

  return cells;
};

export const formatMonth = (date) =>
  date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export const normalizeRecurrence = (recurrence = {}) => {
  const type = ['none', 'daily', 'weekly', 'monthly'].includes(recurrence.type)
    ? recurrence.type
    : 'none';
  const interval = Number.parseInt(recurrence.interval, 10);
  const normalizedInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;
  const until = typeof recurrence.until === 'string' ? recurrence.until.trim() : '';

  return {
    type,
    interval: normalizedInterval,
    until,
  };
};

export const normalizeTime = (time) => {
  if (typeof time === 'string' && /^\d{2}:\d{2}$/.test(time)) {
    return time;
  }

  return '09:00';
};

export const formatReminderScheduleLabel = (recurrence, time) => {
  const normalized = normalizeRecurrence(recurrence);
  const normalizedTime = normalizeTime(time);

  if (normalized.type === 'none') {
    return `One-time at ${normalizedTime}`;
  }

  const untilLabel = normalized.until ? ` until ${normalized.until}` : '';
  return `${normalized.type} at ${normalizedTime}${untilLabel}`;
};

export const occursOnDate = (reminder, dateKey) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reminder?.date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false;
  }

  const recurrence = normalizeRecurrence(reminder.recurrence);
  const { type, interval, until } = recurrence;
  const startKey = reminder.date;

  if (dateKey < startKey) {
    return false;
  }

  if (until && dateKey > until) {
    return false;
  }

  if (type === 'none') {
    return dateKey === startKey;
  }

  if (type === 'daily') {
    return diffInDays(startKey, dateKey) % interval === 0;
  }

  if (type === 'weekly') {
    return diffInDays(startKey, dateKey) % (interval * 7) === 0;
  }

  if (type === 'monthly') {
    const monthOffset = monthsBetween(startKey, dateKey);
    const startDate = parseKey(startKey);
    const currentDate = parseKey(dateKey);

    if (monthOffset < 0 || monthOffset % interval !== 0) {
      return false;
    }

    return currentDate.getDate() === startDate.getDate();
  }

  return false;
};

export const getVisibleMonthCount = (reminders, date) => {
  const counts = new Map();
  for (const reminder of reminders) {
    for (const day of buildCalendarDays(date)) {
      if (!day) continue;
      const key = toKey(day);
      if (occursOnDate(reminder, key)) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
};

export const createReminderPayload = (form, email) => ({
  email,
  title: form.title.trim(),
  notes: form.notes.trim(),
  date: form.date,
  time: normalizeTime(form.time),
  recurrence: normalizeRecurrence(form.recurrence),
});
