import { UNKNOWN_LOT_SHELF_DAYS } from '@erp/shared';
import { effectiveUsableUntilDate, isLotSuitableForDate, isoDateFromDate } from './lot-suitability';

describe('lot suitability policy', () => {
  it('uses explicit usableUntil when set', () => {
    const receivedAt = new Date('2026-10-01T12:00:00.000Z');
    const usableUntil = new Date('2026-10-20T00:00:00.000Z');
    expect(isoDateFromDate(effectiveUsableUntilDate(usableUntil, receivedAt))).toBe('2026-10-20');
  });

  it('does not treat null usableUntil as infinite — uses receipt + UNKNOWN_LOT_SHELF_DAYS', () => {
    const receivedAt = new Date('2026-10-01T15:00:00.000Z');
    const effective = effectiveUsableUntilDate(null, receivedAt);
    // 2026-10-01 + 3 days = 2026-10-04
    expect(isoDateFromDate(effective)).toBe('2026-10-04');
    expect(UNKNOWN_LOT_SHELF_DAYS).toBe(3);
  });

  it('rejects promising undated lot to far-future fulfillment', () => {
    const lot = {
      usableUntil: null,
      receivedAt: new Date('2026-10-01T00:00:00.000Z'),
    };
    expect(isLotSuitableForDate(lot, new Date('2026-10-02T00:00:00.000Z'))).toBe(true);
    expect(isLotSuitableForDate(lot, new Date('2026-10-04T00:00:00.000Z'))).toBe(true);
    expect(isLotSuitableForDate(lot, new Date('2026-10-05T00:00:00.000Z'))).toBe(false);
  });
});
