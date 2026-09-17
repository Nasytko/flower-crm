import { FulfillmentType, OrderStatus } from '@erp/shared';
import { Prisma } from '@erp/database';

/**
 * Mirrors OrdersService shortage + composition helpers used by list DTO.
 * Kept local so lean include (qty fields only) stays contract-tested without Nest DI.
 */
function shortageFromRow(row: {
  reservations: Array<{ requiredQuantity: number; reservedQuantity: number }>;
}): { hasShortage: boolean; shortageProductCount: number } {
  const shortageProductCount = row.reservations.filter(
    (r) => r.reservedQuantity < r.requiredQuantity,
  ).length;
  return { hasShortage: shortageProductCount > 0, shortageProductCount };
}

function compositionSummary(items: Array<{ quantity: number; nameSnapshot: string }>): string {
  return items
    .slice(0, 3)
    .map((i) => `${i.quantity} × ${i.nameSnapshot}`)
    .join(', ');
}

function toListItemShape(row: {
  id: string;
  number: string;
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  fulfillmentDate: Date;
  fulfillmentTimeFrom: string | null;
  fulfillmentTimeTo: string | null;
  customerName: string;
  customerPhone: string;
  recipientName: string | null;
  recipientPhone: string | null;
  deliveryAddressText: string | null;
  total: Prisma.Decimal;
  version: number;
  createdAt: Date;
  items: Array<{ quantity: number; nameSnapshot: string }>;
  reservations: Array<{ requiredQuantity: number; reservedQuantity: number }>;
}) {
  const shortage = shortageFromRow(row);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    fulfillmentType: row.fulfillmentType,
    itemCount: row.items.length,
    compositionSummary: compositionSummary(row.items),
    total: row.total.toFixed(2),
    version: row.version,
    hasShortage: shortage.hasShortage,
    shortageProductCount: shortage.shortageProductCount,
    effectiveRecipientName: row.recipientName?.trim() || row.customerName,
    effectiveRecipientPhone: row.recipientPhone?.trim() || row.customerPhone,
    deliveryAddressText: row.deliveryAddressText,
    createdAt: row.createdAt.toISOString(),
  };
}

describe('order list lean fields contract', () => {
  it('shortage uses only requiredQuantity/reservedQuantity', () => {
    expect(
      shortageFromRow({
        reservations: [
          { requiredQuantity: 5, reservedQuantity: 5 },
          { requiredQuantity: 2, reservedQuantity: 1 },
        ],
      }),
    ).toEqual({ hasShortage: true, shortageProductCount: 1 });
  });

  it('compositionSummary uses quantity + nameSnapshot only (first 3)', () => {
    expect(
      compositionSummary([
        { quantity: 1, nameSnapshot: 'A' },
        { quantity: 2, nameSnapshot: 'B' },
        { quantity: 3, nameSnapshot: 'C' },
        { quantity: 4, nameSnapshot: 'D' },
      ]),
    ).toBe('1 × A, 2 × B, 3 × C');
  });

  it('list shape does not require createdBy/updatedBy', () => {
    const createdAt = new Date('2026-09-15T08:00:00.000Z');
    const item = toListItemShape({
      id: 'o1',
      number: '1509-001',
      status: OrderStatus.NEW,
      fulfillmentType: FulfillmentType.DELIVERY,
      fulfillmentDate: new Date('2026-09-15'),
      fulfillmentTimeFrom: '10:00',
      fulfillmentTimeTo: '12:00',
      customerName: 'Клиент',
      customerPhone: '+375291112233',
      recipientName: null,
      recipientPhone: null,
      deliveryAddressText: 'Минск',
      total: new Prisma.Decimal('99.50'),
      version: 3,
      createdAt,
      items: [{ quantity: 1, nameSnapshot: 'Букет' }],
      reservations: [{ requiredQuantity: 10, reservedQuantity: 10 }],
    });

    expect(item.itemCount).toBe(1);
    expect(item.compositionSummary).toBe('1 × Букет');
    expect(item.total).toBe('99.50');
    expect(item.hasShortage).toBe(false);
    expect(item.shortageProductCount).toBe(0);
    expect(item.effectiveRecipientName).toBe('Клиент');
    expect(item.version).toBe(3);
    expect(item).not.toHaveProperty('createdByName');
    expect(item).not.toHaveProperty('updatedByName');
  });
});
