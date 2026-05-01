/**
 * Reference idle schedule helpers.
 *
 * These windows are a user-provided prior, not a hard rule. They guide
 * fallback predictions and gently bias weak model/lookup output.
 */

export const DEFAULT_IDLE_SCHEDULE = Object.freeze({
  weekday: Object.freeze({ sleep: '01:00', wake: '07:00' }),
  rest: Object.freeze({ sleep: '00:00', wake: '08:30' }),
});

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeTime(value, fallback) {
  const text = String(value || '').trim();
  return TIME_PATTERN.test(text) ? text : fallback;
}

export function normalizeIdleSchedule(schedule = {}) {
  const raw = schedule && typeof schedule === 'object' ? schedule : {};
  const weekday = raw.weekday && typeof raw.weekday === 'object' ? raw.weekday : {};
  const rest = raw.rest && typeof raw.rest === 'object' ? raw.rest : {};

  return {
    weekday: {
      sleep: normalizeTime(weekday.sleep, DEFAULT_IDLE_SCHEDULE.weekday.sleep),
      wake: normalizeTime(weekday.wake, DEFAULT_IDLE_SCHEDULE.weekday.wake),
    },
    rest: {
      sleep: normalizeTime(rest.sleep, DEFAULT_IDLE_SCHEDULE.rest.sleep),
      wake: normalizeTime(rest.wake, DEFAULT_IDLE_SCHEDULE.rest.wake),
    },
  };
}

export function timeToHour(value, fallback = 0) {
  const text = normalizeTime(value, null);
  if (!text) return fallback;
  const [hour, minute] = text.split(':').map(Number);
  return hour + minute / 60;
}

export function referenceWindowForRestLevel(schedule, restLevel) {
  const normalized = normalizeIdleSchedule(schedule);
  return restLevel > 0 ? normalized.rest : normalized.weekday;
}

export function hourInWindow(hourValue, window) {
  const start = timeToHour(window?.sleep, timeToHour(DEFAULT_IDLE_SCHEDULE.weekday.sleep, 1));
  const end = timeToHour(window?.wake, timeToHour(DEFAULT_IDLE_SCHEDULE.weekday.wake, 7));
  const hour = ((Number(hourValue) % 24) + 24) % 24;

  if (start === end) return false;
  if (start > end) return hour >= start || hour < end;
  return hour >= start && hour < end;
}

export function scheduleToIPC(schedule) {
  return normalizeIdleSchedule(schedule);
}
