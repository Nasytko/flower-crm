import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrderStatus } from '@erp/shared';
import {
  keysAfterInventoryCancel,
  keysAfterInventoryComplete,
  keysAfterInventoryStart,
  keysAfterOrderSave,
  keysAfterOrderStatusChange,
  keysAfterSupplyDraftSave,
  keysAfterSupplyPaymentChange,
  keysAfterSupplyStockMutation,
} from './query-invalidation.ts';

function hasPrefix(keys: readonly unknown[][], prefix: string): boolean {
  return keys.some((key) => key[0] === prefix);
}

describe('query invalidation policy', () => {
  it('A: non-stock order status only invalidates orders', () => {
    for (const status of [OrderStatus.NEW, OrderStatus.READY]) {
      const keys = keysAfterOrderStatusChange(status);
      assert.equal(hasPrefix(keys, 'orders'), true);
      assert.equal(hasPrefix(keys, 'products'), false);
      assert.equal(hasPrefix(keys, 'bouquets'), false);
      assert.equal(hasPrefix(keys, 'inventories'), false);
    }
  });

  it('B: COMPLETED invalidates orders + physical stock views', () => {
    const keys = keysAfterOrderStatusChange(OrderStatus.COMPLETED);
    assert.equal(hasPrefix(keys, 'orders'), true);
    assert.equal(hasPrefix(keys, 'products'), true);
    assert.equal(hasPrefix(keys, 'bouquets'), true);
    assert.equal(hasPrefix(keys, 'inventories'), false);
  });

  it('C: CANCELLED invalidates orders + physical stock views (reallocate)', () => {
    const keys = keysAfterOrderStatusChange(OrderStatus.CANCELLED);
    assert.equal(hasPrefix(keys, 'orders'), true);
    assert.equal(hasPrefix(keys, 'products'), true);
    assert.equal(hasPrefix(keys, 'bouquets'), true);
  });

  it('D: supply paid/unpaid only invalidates supplies', () => {
    const keys = keysAfterSupplyPaymentChange();
    assert.deepEqual(keys, [['supplies']]);
    assert.equal(hasPrefix(keys, 'products'), false);
    assert.equal(hasPrefix(keys, 'bouquets'), false);
    assert.equal(hasPrefix(keys, 'orders'), false);
    assert.equal(hasPrefix(keys, 'inventories'), false);
  });

  it('E: supply POST invalidates supplies + stock + orders', () => {
    const keys = keysAfterSupplyStockMutation();
    assert.equal(hasPrefix(keys, 'supplies'), true);
    assert.equal(hasPrefix(keys, 'products'), true);
    assert.equal(hasPrefix(keys, 'bouquets'), true);
    assert.equal(hasPrefix(keys, 'orders'), true);
  });

  it('F: inventory complete invalidates inventories + stock + orders', () => {
    const keys = keysAfterInventoryComplete();
    assert.equal(hasPrefix(keys, 'inventories'), true);
    assert.equal(hasPrefix(keys, 'products'), true);
    assert.equal(hasPrefix(keys, 'bouquets'), true);
    assert.equal(hasPrefix(keys, 'orders'), true);
  });

  it('order save reconciles reservations → orders + stock', () => {
    const keys = keysAfterOrderSave();
    assert.equal(hasPrefix(keys, 'orders'), true);
    assert.equal(hasPrefix(keys, 'products'), true);
    assert.equal(hasPrefix(keys, 'bouquets'), true);
  });

  it('supply draft save does not touch stock views', () => {
    const keys = keysAfterSupplyDraftSave();
    assert.deepEqual(keys, [['supplies']]);
  });

  it('inventory start/cancel only touch inventories (freeze)', () => {
    assert.deepEqual(keysAfterInventoryStart(), [['inventories']]);
    assert.deepEqual(keysAfterInventoryCancel(), [['inventories']]);
  });
});
