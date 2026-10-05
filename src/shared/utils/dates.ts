/** Calendar-date helpers. Dates are ISO strings (YYYY-MM-DD) throughout the domain. */

export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's calendar date in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Whole days from `from` to `to` (positive if `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function addYears(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, d));
  // 29 Feb → 28 Feb in non-leap years.
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}
