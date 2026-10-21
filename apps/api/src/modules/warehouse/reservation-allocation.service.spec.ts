import { OrderItemType, ProductType } from '@erp/shared';
import { ReservationAllocationService } from './reservation-allocation.service';

describe('ReservationAllocationService', () => {
  const service = new ReservationAllocationService(
    { log: jest.fn() } as never,
    { suitableRemainingQuantity: jest.fn() } as never,
  );

  it('builds flower requirements from product and bouquet snapshot', () => {
    const map = service.buildRequirementsFromItems([
      {
        itemType: OrderItemType.PRODUCT,
        productId: 'rose',
        quantity: 10,
        nameSnapshot: 'Роза',
        product: { type: ProductType.FLOWER, name: 'Роза красная' },
        components: [],
      },
      {
        itemType: OrderItemType.BOUQUET,
        productId: null,
        quantity: 1,
        nameSnapshot: 'Букет',
        components: [
          {
            productId: 'rose',
            productNameSnapshot: 'Роза красная',
            productTypeSnapshot: ProductType.FLOWER,
            totalQuantity: 15,
          },
          {
            productId: 'svc',
            productNameSnapshot: 'Услуга',
            productTypeSnapshot: ProductType.SERVICE,
            totalQuantity: 1,
          },
        ],
      },
    ]);
    expect(map.get('rose')?.required).toBe(25);
    expect(map.has('svc')).toBe(false);
  });

  it('orders priority by fulfillment date then time then createdAt then number', () => {
    const early = {
      id: '1',
      number: '210926-002',
      fulfillmentDate: new Date('2026-10-21'),
      fulfillmentTimeFrom: '10:00',
      createdAt: new Date('2026-10-20T12:00:00Z'),
    };
    const laterSameDay = {
      id: '2',
      number: '210926-001',
      fulfillmentDate: new Date('2026-10-21'),
      fulfillmentTimeFrom: '18:00',
      createdAt: new Date('2026-10-19T12:00:00Z'),
    };
    const nextDay = {
      id: '3',
      number: '220926-001',
      fulfillmentDate: new Date('2026-10-22'),
      fulfillmentTimeFrom: null,
      createdAt: new Date('2026-10-18T12:00:00Z'),
    };
    expect(service.comparePriority(early, laterSameDay)).toBeLessThan(0);
    expect(service.comparePriority(laterSameDay, nextDay)).toBeLessThan(0);
    expect(service.comparePriority(early, nextDay)).toBeLessThan(0);
  });

  it('maps shortage dto correctly', () => {
    const dtos = service.toRequirementDtos(
      new Map([['p1', { productId: 'p1', productName: 'Роза', required: 30 }]]),
      [{ productId: 'p1', requiredQuantity: 30, reservedQuantity: 5 }],
    );
    expect(dtos).toEqual([
      {
        productId: 'p1',
        productName: 'Роза',
        requiredQuantity: 30,
        reservedQuantity: 5,
        shortageQuantity: 25,
      },
    ]);
    expect(service.shortageSummary(dtos)).toEqual({
      hasShortage: true,
      shortageProductCount: 1,
    });
  });
});
