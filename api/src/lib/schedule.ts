import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Campaign schedules are whole days in the merchant's time zone: from midnight on the first day to midnight after
 * the last one. The dashboard sends its time zone with each agent request; tools read it from this context.
 */
export interface MerchantContext { shop: string; timezone: string }
export const merchantContext = new AsyncLocalStorage<MerchantContext>();

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** "YYYY-MM-DD" for the current day in the time zone. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Adds calendar days to a "YYYY-MM-DD" date (no time zone involved, so DST can't shift it). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutes(tz: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant midnight starts on `date` in `tz`. */
export function zonedMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Two passes settle the offset even when midnight sits next to a DST change.
  let t = guess - offsetMinutes(tz, new Date(guess)) * 60_000;
  t = guess - offsetMinutes(tz, new Date(t)) * 60_000;
  return new Date(t);
}

export function scheduleWindow(startDate: string, days: number, tz: string): { startsAt: string; endsAt: string } {
  return { startsAt: zonedMidnight(startDate, tz).toISOString(), endsAt: zonedMidnight(addDays(startDate, days), tz).toISOString() };
}

export function describeWindow(startsAt: string | null, endsAt: string | null, tz: string): string {
  if (!startsAt || !endsAt) return "always on";
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const start = new Date(startsAt), end = new Date(endsAt);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return days <= 1 ? `on ${fmt(start)}` : `${fmt(start)} → ${fmt(new Date(end.getTime() - 1))} (${days} days)`;
}

// ------------------------------------------------------------------ plain-English dates (offline mode)

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function thanksgiving(year: number): number {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();   // weekday of Nov 1
  return 1 + ((4 - first + 7) % 7) + 21;                          // fourth Thursday
}

/** The next occurrence (today or later) of a month/day, or of a named shopping day. */
function nextDate(today: string, month: number, day: number): string {
  const year = Number(today.slice(0, 4));
  const candidate = iso(year, month, day);
  return candidate >= today ? candidate : iso(year + 1, month, day);
}
function nextHoliday(today: string, which: "black friday" | "cyber monday"): string {
  const year = Number(today.slice(0, 4));
  const at = (y: number) => addDays(iso(y, 11, thanksgiving(y)), which === "black friday" ? 1 : 4);
  return at(year) >= today ? at(year) : at(year + 1);
}

export interface ParsedSchedule { startDate: string; days: number; label: string | null }

/**
 * Reads a schedule from a brief: "on Nov 20", "from 2026-12-01 for 15 days", "tomorrow", "for 15 consecutive days",
 * "Black Friday", "Cyber Monday". A date alone means that one day; a length alone starts today. Nothing found: null.
 */
export function parseSchedule(text: string, today: string): ParsedSchedule | null {
  const t = text.toLowerCase();
  let start: string | null = null;
  let label: string | null = null;

  const isoDate = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(t);
  const monthDay = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})[a-z]*\\b`).exec(t);
  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  const holiday = /\b(black friday|cyber monday)\b/.exec(t);

  if (isoDate) start = `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  else if (monthDay) start = nextDate(today, MONTHS.indexOf(monthDay[1]) + 1, Number(monthDay[2]));
  else if (dayMonth) start = nextDate(today, MONTHS.indexOf(dayMonth[2]) + 1, Number(dayMonth[1]));
  else if (slash && Number(slash[1]) >= 1 && Number(slash[1]) <= 12 && Number(slash[2]) >= 1 && Number(slash[2]) <= 31) {
    start = nextDate(today, Number(slash[1]), Number(slash[2]));
  }
  else if (/\btomorrow\b/.test(t)) start = addDays(today, 1);
  else if (/\btoday\b/.test(t)) start = today;
  if (holiday) {
    label = holiday[1].replace(/\b\w/g, (c) => c.toUpperCase());
    start ??= nextHoliday(today, holiday[1] as "black friday" | "cyber monday");
  }
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) start = null;

  const len = /\bfor\s+(\d{1,3})\s+(?:consecutive\s+|straight\s+)?days?\b/.exec(t) ?? /\b(\d{1,3})[\s-]+days?\b/.exec(t);
  const weeks = /\bfor\s+(\d{1,2})\s+weeks?\b/.exec(t) ?? (/\bfor\s+a\s+week\b/.test(t) ? [, "1"] : null);
  const days = len ? Number(len[1]) : weeks ? Number(weeks[1]) * 7 : null;

  if (!start && !days) return null;
  return { startDate: start ?? today, days: Math.min(Math.max(days ?? 1, 1), 366), label };
}
