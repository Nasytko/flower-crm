/** Format YYYY-MM-DD in the given IANA time zone. */
export function businessDateString(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** HH:mm in business time zone (24h). */
export function businessTimeHm(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** Convert YYYY-MM-DD → DDMMYY for order numbers. */
export function toOrderNumberDatePrefix(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) {
    throw new Error('INVALID_BUSINESS_DATE');
  }
  return `${day}${month}${year.slice(2)}`;
}

export function formatOrderNumber(isoDate: string, seq: number): string {
  return `${toOrderNumberDatePrefix(isoDate)}-${String(seq).padStart(3, '0')}`;
}

export function parseIsoDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('INVALID_DATE');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error('INVALID_DATE');
  }
  return date;
}

export function isoDateFromDb(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isValidHm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function compareHm(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Shift YYYY-MM-DD by delta days (UTC date arithmetic on calendar date). */
export function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const date = parseIsoDateOnly(isoDate);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}
