import {
  businessDateString,
  formatOrderNumber,
  isValidHm,
  toOrderNumberDatePrefix,
} from './business-time';

describe('business-time / order numbering helpers', () => {
  it('formats business date in Europe/Minsk', () => {
    // 2026-09-15 22:30 UTC → 2026-09-16 01:30 in Minsk (UTC+3)
    const date = new Date('2026-09-15T22:30:00.000Z');
    expect(businessDateString(date, 'Europe/Minsk')).toBe('2026-09-16');
  });

  it('builds DDMMYY-NNN numbers', () => {
    expect(toOrderNumberDatePrefix('2026-09-15')).toBe('150926');
    expect(formatOrderNumber('2026-09-15', 1)).toBe('150926-001');
    expect(formatOrderNumber('2026-09-15', 12)).toBe('150926-012');
  });

  it('validates HH:mm', () => {
    expect(isValidHm('09:30')).toBe(true);
    expect(isValidHm('23:59')).toBe(true);
    expect(isValidHm('24:00')).toBe(false);
    expect(isValidHm('9:30')).toBe(false);
  });
});
