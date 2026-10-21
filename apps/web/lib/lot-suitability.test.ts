import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_LOT_SHELF_DAYS, addCalendarDaysIso, effectiveUsableUntilIso } from '@erp/shared';

describe('effectiveUsableUntilIso (shared policy)', () => {
  it('keeps explicit usableUntil', () => {
    assert.equal(effectiveUsableUntilIso('2026-11-01', '2026-10-01'), '2026-11-01');
  });

  it('null usableUntil is not infinite', () => {
    assert.equal(
      effectiveUsableUntilIso(null, '2026-10-01'),
      addCalendarDaysIso('2026-10-01', UNKNOWN_LOT_SHELF_DAYS),
    );
  });
});
