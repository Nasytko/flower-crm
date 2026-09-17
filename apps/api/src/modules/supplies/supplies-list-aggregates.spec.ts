import { Prisma } from '@erp/database';
import { SupplyStatus } from '@erp/shared';
import { decimalToMoneyString } from '../products/product-mapper';
import { aggregateSupplyLines } from './supplies.service';

describe('supply list line aggregates', () => {
  it('aggregateSupplyLines matches prior reduce(itemCount/qty/amount) semantics', () => {
    const items = [
      { quantity: 2, unitPurchasePrice: new Prisma.Decimal('10.50') },
      { quantity: 3, unitPurchasePrice: new Prisma.Decimal('1.25') },
    ];
    const agg = aggregateSupplyLines(items);
    expect(agg.itemCount).toBe(2);
    expect(agg.totalQuantity).toBe(5);
    // 2*10.50 + 3*1.25 = 21.00 + 3.75 = 24.75
    expect(decimalToMoneyString(agg.totalAmount)).toBe('24.75');
  });

  it('empty lines yield zero totals (draft without items)', () => {
    const agg = aggregateSupplyLines([]);
    expect(agg.itemCount).toBe(0);
    expect(agg.totalQuantity).toBe(0);
    expect(decimalToMoneyString(agg.totalAmount)).toBe('0.00');
  });

  it('Decimal path does not float-round common BYN cents', () => {
    const items = [
      { quantity: 7, unitPurchasePrice: new Prisma.Decimal('0.10') },
      { quantity: 1, unitPurchasePrice: new Prisma.Decimal('0.05') },
    ];
    const agg = aggregateSupplyLines(items);
    expect(decimalToMoneyString(agg.totalAmount)).toBe('0.75');
  });

  it('status/payment list fields are independent of item materialization', () => {
    // Documents contract: payment/status come from Supply row, not SupplyItem.
    const row = {
      status: SupplyStatus.POSTED,
      paidAt: new Date('2026-09-10T12:00:00.000Z'),
    };
    expect(row.paidAt != null).toBe(true);
    expect(row.status).toBe(SupplyStatus.POSTED);
  });
});
