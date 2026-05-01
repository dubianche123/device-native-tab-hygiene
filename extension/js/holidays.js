/**
 * Neural-Janitor — Holiday Calendar Module
 *
 * Provides Japanese and Chinese public holiday data (2025–2027) so that
 * the idle-prediction heuristic can widen its confidence window on days
 * when users are statistically more likely to be away.
 *
 * Two layers:
 *   1. Public holidays (single-day or multi-day official holidays)
 *   2. Extended holiday periods (Golden Week, Obon, year-end/New Year,
 *      Spring Festival, National Day week) — broader windows where idle
 *      probability is elevated even on adjacent non-holiday days.
 */

// ── Japanese Public Holidays (国民の祝日) ──────────────────────────────

const JAPAN_HOLIDAYS = {
  // 2025
  '2025-01-01': '元日',
  '2025-01-13': '成人の日',
  '2025-02-11': '建国記念の日',
  '2025-02-23': '天皇誕生日',
  '2025-03-20': '春分の日',
  '2025-04-29': '昭和の日',
  '2025-05-03': '憲法記念日',
  '2025-05-04': 'みどりの日',
  '2025-05-05': 'こどもの日',
  '2025-05-06': '振替休日',
  '2025-07-21': '海の日',
  '2025-08-11': '山の日',
  '2025-09-15': '敬老の日',
  '2025-09-23': '秋分の日',
  '2025-10-13': 'スポーツの日',
  '2025-11-03': '文化の日',
  '2025-11-23': '勤労感謝の日',
  '2025-11-24': '振替休日',
  // 2026
  '2026-01-01': '元日',
  '2026-01-12': '成人の日',
  '2026-02-11': '建国記念の日',
  '2026-02-23': '天皇誕生日',
  '2026-03-20': '春分の日',
  '2026-04-29': '昭和の日',
  '2026-05-03': '憲法記念日',
  '2026-05-04': 'みどりの日',
  '2026-05-05': 'こどもの日',
  '2026-05-06': '振替休日',
  '2026-07-20': '海の日',
  '2026-08-11': '山の日',
  '2026-09-21': '敬老の日',
  '2026-09-22': '秋分の日',
  '2026-10-12': 'スポーツの日',
  '2026-11-03': '文化の日',
  '2026-11-23': '勤労感謝の日',
  // 2027
  '2027-01-01': '元日',
  '2027-01-11': '成人の日',
  '2027-02-11': '建国記念の日',
  '2027-02-23': '天皇誕生日',
  '2027-03-21': '春分の日',
  '2027-04-29': '昭和の日',
  '2027-05-03': '憲法記念日',
  '2027-05-04': 'みどりの日',
  '2027-05-05': 'こどもの日',
  '2027-07-19': '海の日',
  '2027-08-11': '山の日',
  '2027-09-20': '敬老の日',
  '2027-09-23': '秋分の日',
  '2027-10-11': 'スポーツの日',
  '2027-11-03': '文化の日',
  '2027-11-23': '勤労感謝の日',
};

// Extended idle periods in Japan — users are very likely away
const JAPAN_EXTENDED_PERIODS = [
  // Year-end / New Year (年末年始)
  { start: '2024-12-28', end: '2025-01-03', label: '年末年始' },
  { start: '2025-12-28', end: '2026-01-03', label: '年末年始' },
  { start: '2026-12-28', end: '2027-01-03', label: '年末年始' },
  // Golden Week (ゴールデンウィーク)
  { start: '2025-04-29', end: '2025-05-06', label: 'GW' },
  { start: '2026-04-29', end: '2026-05-06', label: 'GW' },
  { start: '2027-04-29', end: '2027-05-05', label: 'GW' },
  // Obon (お盆)
  { start: '2025-08-13', end: '2025-08-16', label: 'お盆' },
  { start: '2026-08-13', end: '2026-08-16', label: 'お盆' },
  { start: '2027-08-13', end: '2027-08-16', label: 'お盆' },
  // Silver Week 2026 (敬老の日+秋分の日 with gap)
  { start: '2026-09-19', end: '2026-09-23', label: 'シルバーウィーク' },
];

// ── Chinese Public Holidays (中国法定假日) ─────────────────────────────

const CHINA_HOLIDAYS = {
  // 2025
  '2025-01-01': '元旦',
  '2025-01-28': '春节',
  '2025-01-29': '春节',
  '2025-01-30': '春节',
  '2025-01-31': '春节',
  '2025-02-01': '春节',
  '2025-02-02': '春节',
  '2025-02-03': '春节',
  '2025-02-04': '春节',
  '2025-04-04': '清明节',
  '2025-05-01': '劳动节',
  '2025-05-02': '劳动节',
  '2025-05-03': '劳动节',
  '2025-05-04': '劳动节',
  '2025-05-05': '劳动节',
  '2025-05-31': '端午节',
  '2025-10-01': '国庆节',
  '2025-10-02': '国庆节',
  '2025-10-03': '国庆节',
  '2025-10-04': '国庆节',
  '2025-10-05': '国庆节',
  '2025-10-06': '国庆节',
  '2025-10-07': '国庆节',
  // 2026
  '2026-01-01': '元旦',
  '2026-01-02': '元旦',
  '2026-02-17': '春节',
  '2026-02-18': '春节',
  '2026-02-19': '春节',
  '2026-02-20': '春节',
  '2026-04-05': '清明节',
  '2026-05-01': '劳动节',
  '2026-05-02': '劳动节',
  '2026-05-03': '劳动节',
  '2026-06-19': '端午节',
  '2026-09-25': '中秋节',
  '2026-10-01': '国庆节',
  '2026-10-02': '国庆节',
  '2026-10-03': '国庆节',
  '2026-10-04': '国庆节',
  '2026-10-05': '国庆节',
  '2026-10-06': '国庆节',
  '2026-10-07': '国庆节',
  // 2027
  '2027-01-01': '元旦',
  '2027-02-06': '春节',
  '2027-02-07': '春节',
  '2027-02-08': '春节',
  '2027-02-09': '春节',
  '2027-04-05': '清明节',
  '2027-05-01': '劳动节',
  '2027-05-02': '劳动节',
  '2027-05-03': '劳动节',
  '2027-06-09': '端午节',
  '2027-10-01': '国庆节',
  '2027-10-02': '国庆节',
  '2027-10-03': '国庆节',
  '2027-10-04': '国庆节',
  '2027-10-05': '国庆节',
  '2027-10-06': '国庆节',
  '2027-10-07': '国庆节',
};

// Extended idle periods in China
const CHINA_EXTENDED_PERIODS = [
  // Spring Festival (春节) — extends beyond official days
  { start: '2025-01-25', end: '2025-02-05', label: '春节假期' },
  { start: '2026-02-14', end: '2026-02-22', label: '春节假期' },
  { start: '2027-02-03', end: '2027-02-11', label: '春节假期' },
  // National Day (国庆节)
  { start: '2025-10-01', end: '2025-10-07', label: '国庆假期' },
  { start: '2026-10-01', end: '2026-10-07', label: '国庆假期' },
  { start: '2027-10-01', end: '2027-10-07', label: '国庆假期' },
  // May Day (劳动节)
  { start: '2025-05-01', end: '2025-05-05', label: '五一假期' },
  { start: '2026-05-01', end: '2026-05-03', label: '五一假期' },
  { start: '2027-05-01', end: '2027-05-03', label: '五一假期' },
];

// ── Calendar registry ─────────────────────────────────────────────────

export const CALENDAR_OPTIONS = Object.freeze({
  none: { label: 'Off', icon: '—' },
  japan: { label: '日本 🇯🇵', icon: '🇯🇵' },
  china: { label: '中国 🇨🇳', icon: '🇨🇳' },
});

const HOLIDAY_MAPS = { japan: JAPAN_HOLIDAYS, china: CHINA_HOLIDAYS };
const EXTENDED_MAPS = { japan: JAPAN_EXTENDED_PERIODS, china: CHINA_EXTENDED_PERIODS };

// ── Public API ────────────────────────────────────────────────────────

/**
 * Format a Date (or date string) as "YYYY-MM-DD".
 */
function toDateKey(date) {
  if (typeof date === 'string') return date.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns the holiday name if `date` is a public holiday, otherwise null.
 */
export function getHolidayName(date, calendar) {
  const map = HOLIDAY_MAPS[calendar];
  if (!map) return null;
  return map[toDateKey(date)] || null;
}

/**
 * Returns the extended-period label if `date` falls within one, otherwise null.
 */
export function getExtendedPeriodLabel(date, calendar) {
  const key = toDateKey(date);
  const periods = EXTENDED_MAPS[calendar];
  if (!periods) return null;
  for (const p of periods) {
    if (key >= p.start && key <= p.end) return p.label;
  }
  return null;
}

/**
 * True if `date` is a public holiday in the given calendar.
 */
export function isHoliday(date, calendar) {
  return getHolidayName(date, calendar) !== null;
}

/**
 * True if `date` falls within an extended holiday period (broader than
 * the official single-day holiday — e.g. Golden Week, Spring Festival).
 */
export function isInExtendedPeriod(date, calendar) {
  return getExtendedPeriodLabel(date, calendar) !== null;
}

/**
 * Returns a combined "rest day" score for a given date:
 *   0 = normal working day
 *   1 = weekend (Sat/Sun)
 *   2 = public holiday or extended holiday period
 *
 * Used by the idle heuristic to widen the predicted idle window.
 */
export function getRestDayLevel(date, calendar) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const dow = d.getDay();

  if (calendar && calendar !== 'none') {
    if (isHoliday(d, calendar) || isInExtendedPeriod(d, calendar)) return 2;
  }

  return (dow === 0 || dow === 6) ? 1 : 0;
}

/**
 * Returns an array of upcoming holidays (within `daysAhead` days from now)
 * for display in the predictions panel.
 */
export function getUpcomingHolidays(calendar, daysAhead = 14) {
  const map = HOLIDAY_MAPS[calendar];
  if (!map) return [];

  const today = new Date();
  const result = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * 86_400_000);
    const key = toDateKey(d);
    if (map[key]) {
      result.push({ date: key, name: map[key], dayOfWeek: d.getDay() });
    }
  }
  return result;
}
