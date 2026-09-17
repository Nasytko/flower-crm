import { InventoryStatus } from '@erp/shared';
import {
  summarizeItems,
  toInventoryListItem,
} from './inventory-mapper';

describe('inventory list contract (lean aggregates)', () => {
  it('summarizeItems matches list SQL FILTER semantics for counts', () => {
    const items = [
      { expectedQuantity: 10, countedQuantity: null },
      { expectedQuantity: 5, countedQuantity: 5 },
      { expectedQuantity: 3, countedQuantity: 4 },
      { expectedQuantity: 8, countedQuantity: 6 },
    ];
    const summary = summarizeItems(items);
    expect(summary.itemCount).toBe(4);
    expect(summary.countedItemCount).toBe(3);
    expect(summary.differenceItemCount).toBe(2);
    expect(summary.positiveQuantity).toBe(1);
    expect(summary.negativeQuantity).toBe(2);
  });

  it('toInventoryListItem preserves DTO fields from header + aggregates', () => {
    const startedAt = new Date('2026-09-01T10:00:00.000Z');
    const createdAt = new Date('2026-09-01T09:00:00.000Z');
    const item = toInventoryListItem(
      {
        id: 'inv-1',
        number: 12,
        status: InventoryStatus.IN_PROGRESS,
        comment: 'note',
        startedAt,
        completedAt: null,
        createdAt,
        createdBy: { name: 'Анна' },
        completedBy: null,
      },
      { itemCount: 100, countedItemCount: 40, differenceItemCount: 7 },
    );

    expect(item).toEqual({
      id: 'inv-1',
      number: 12,
      numberLabel: 'INV-000012',
      status: InventoryStatus.IN_PROGRESS,
      comment: 'note',
      itemCount: 100,
      countedItemCount: 40,
      differenceItemCount: 7,
      createdByName: 'Анна',
      completedByName: null,
      startedAt: startedAt.toISOString(),
      completedAt: null,
      createdAt: createdAt.toISOString(),
    });
  });
});
