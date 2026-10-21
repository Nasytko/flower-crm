import { UNKNOWN_LOT_SHELF_DAYS, addCalendarDaysIso } from '@erp/shared';

/** YYYY-MM-DD from a Date (UTC calendar). */
export function isoDateFromDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Effective last usable calendar day for a lot.
 *
 * Policy (documented in docs/lot-suitability.md):
 * - Explicit usableUntil → use it.
 * - Null usableUntil → NOT treated as infinite. Effective end =
 *   calendar date of receivedAt + UNKNOWN_LOT_SHELF_DAYS (default 3).
 *   Far-future orders cannot be promised undated stock.
 */
export function effectiveUsableUntilDate(
  usableUntil: Date | null | undefined,
  receivedAt: Date,
): Date {
  if (usableUntil) {
    return new Date(`${isoDateFromDate(usableUntil)}T00:00:00.000Z`);
  }
  const receivedIso = isoDateFromDate(receivedAt);
  const effectiveIso = addCalendarDaysIso(receivedIso, UNKNOWN_LOT_SHELF_DAYS);
  return new Date(`${effectiveIso}T00:00:00.000Z`);
}

export function isLotSuitableForDate(
  lot: { usableUntil: Date | null; receivedAt: Date },
  fulfillmentDate: Date,
): boolean {
  const effective = effectiveUsableUntilDate(lot.usableUntil, lot.receivedAt);
  const need = new Date(`${isoDateFromDate(fulfillmentDate)}T00:00:00.000Z`);
  return effective.getTime() >= need.getTime();
}

export { UNKNOWN_LOT_SHELF_DAYS };
