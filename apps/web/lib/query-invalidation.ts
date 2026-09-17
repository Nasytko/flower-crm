import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { OrderStatus } from '@erp/shared';

/**
 * Pure invalidation policy for TanStack Query.
 * Helpers map mutations → query key prefixes that must become stale.
 * Partial matching: ['orders'] matches list/detail but NOT business-time
 * (business-time lives under ['business-time']).
 */

export function ordersKey(): QueryKey {
  return ['orders'];
}

export function productsKey(): QueryKey {
  return ['products'];
}

export function bouquetsKey(): QueryKey {
  return ['bouquets'];
}

export function suppliesKey(): QueryKey {
  return ['supplies'];
}

export function inventoriesKey(): QueryKey {
  return ['inventories'];
}

/** Physical stock + bouquet availability (lots / on-hand / reserved effects). */
export function physicalStockKeys(): QueryKey[] {
  return [productsKey(), bouquetsKey()];
}

/**
 * Backend changeStatus:
 * - NEW / READY: status (+ timestamps) only; assertNoShortage does not mutate stock.
 * - COMPLETED: FIFO consume → physical stock changes.
 * - CANCELLED: releaseAllForOrder({ reallocate: true }) → stock availability + other orders.
 */
export function keysAfterOrderStatusChange(status: OrderStatus): QueryKey[] {
  if (status === OrderStatus.COMPLETED || status === OrderStatus.CANCELLED) {
    return [ordersKey(), ...physicalStockKeys()];
  }
  return [ordersKey()];
}

/** create/update reconcile reservations (may reallocate). */
export function keysAfterOrderSave(): QueryKey[] {
  return [ordersKey(), ...physicalStockKeys()];
}

/** Draft supply create/update — no stock mutation. */
export function keysAfterSupplyDraftSave(): QueryKey[] {
  return [suppliesKey()];
}

/** POST / correction / cancel-reversal — lots + allocation. */
export function keysAfterSupplyStockMutation(): QueryKey[] {
  return [suppliesKey(), ...physicalStockKeys(), ordersKey()];
}

/** paid/unpaid — payment fields only. */
export function keysAfterSupplyPaymentChange(): QueryKey[] {
  return [suppliesKey()];
}

/** Start inventory — warehouse freeze flag (active session), no stock qty change. */
export function keysAfterInventoryStart(): QueryKey[] {
  return [inventoriesKey()];
}

/** Complete inventory — adjustments to on-hand / lots. */
export function keysAfterInventoryComplete(): QueryKey[] {
  return [inventoriesKey(), ...physicalStockKeys(), ordersKey()];
}

/** Cancel inventory — unfreeze only. */
export function keysAfterInventoryCancel(): QueryKey[] {
  return [inventoriesKey()];
}

/**
 * Manual warehouse write-off mutates ProductStock (onHand) + FIFO lots.
 * Bouquet availableBouquets = min(floor(availableStock / recipeQty)) over FLOWER lines
 * where availableStock = onHand − reserved — so bouquets must refetch.
 * Does not touch order rows or inventory freeze.
 */
export function keysAfterManualWriteOff(): QueryKey[] {
  return physicalStockKeys();
}

async function invalidateKeys(qc: QueryClient, keys: QueryKey[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

export async function invalidateOrders(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, [ordersKey()]);
}

export async function invalidateProducts(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, [productsKey()]);
}

export async function invalidateBouquets(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, [bouquetsKey()]);
}

export async function invalidateSupplies(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, [suppliesKey()]);
}

export async function invalidateInventories(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, [inventoriesKey()]);
}

export async function invalidatePhysicalStockViews(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, physicalStockKeys());
}

export async function invalidateAfterOrderStatusChange(
  qc: QueryClient,
  status: OrderStatus,
): Promise<void> {
  await invalidateKeys(qc, keysAfterOrderStatusChange(status));
}

export async function invalidateAfterOrderSave(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterOrderSave());
}

export async function invalidateAfterSupplyDraftSave(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterSupplyDraftSave());
}

export async function invalidateAfterSupplyStockMutation(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterSupplyStockMutation());
}

export async function invalidateAfterSupplyPaymentChange(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterSupplyPaymentChange());
}

export async function invalidateAfterInventoryStart(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterInventoryStart());
}

export async function invalidateAfterInventoryComplete(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterInventoryComplete());
}

export async function invalidateAfterInventoryCancel(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterInventoryCancel());
}

export async function invalidateAfterManualWriteOff(qc: QueryClient): Promise<void> {
  await invalidateKeys(qc, keysAfterManualWriteOff());
}
