import { Prisma } from '@erp/database';
import { OrderPaymentStatus, PaymentKind, PaymentStatus } from '@erp/shared';
import { computeOrderPaymentSummary, type PaymentCalcInput } from './payment-calc';

const D = (v: string) => new Prisma.Decimal(v);

function pay(
  kind: PaymentKind,
  status: PaymentStatus,
  amount: string,
): PaymentCalcInput {
  return { kind, status, amount: D(amount) };
}

describe('computeOrderPaymentSummary', () => {
  it('no payments → UNPAID, full remaining due', () => {
    const s = computeOrderPaymentSummary(D('100.00'), []);
    expect(s).toMatchObject({
      orderTotal: '100.00',
      confirmedPaid: '0.00',
      confirmedRefunded: '0.00',
      netPaid: '0.00',
      pendingAmount: '0.00',
      remainingDue: '100.00',
      paymentProgressPercent: 0,
      paymentStatus: OrderPaymentStatus.UNPAID,
    });
  });

  it('partial confirmed payment → PARTIALLY_PAID with progress', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '30.00'),
    ]);
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
    expect(s.netPaid).toBe('30.00');
    expect(s.remainingDue).toBe('70.00');
    expect(s.paymentProgressPercent).toBe(30);
  });

  it('exact payment → PAID', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '60.00'),
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '40.00'),
    ]);
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PAID);
    expect(s.remainingDue).toBe('0.00');
    expect(s.paymentProgressPercent).toBe(100);
  });

  it('PENDING charge is tracked but not counted as paid', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.PENDING, '100.00'),
    ]);
    expect(s.pendingAmount).toBe('100.00');
    expect(s.confirmedPaid).toBe('0.00');
    expect(s.netPaid).toBe('0.00');
    expect(s.remainingDue).toBe('100.00');
    expect(s.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
  });

  it('FAILED / CANCELLED charges are ignored', () => {
    const s = computeOrderPaymentSummary(D('50.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.FAILED, '50.00'),
      pay(PaymentKind.CHARGE, PaymentStatus.CANCELLED, '50.00'),
    ]);
    expect(s.pendingAmount).toBe('0.00');
    expect(s.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
  });

  it('overpay keeps PAID with remainingDue 0 and capped progress', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '120.00'),
    ]);
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PAID);
    expect(s.netPaid).toBe('120.00');
    expect(s.remainingDue).toBe('0.00');
    expect(s.paymentProgressPercent).toBe(100);
  });

  it('full confirmed refund → REFUNDED', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '100.00'),
      pay(PaymentKind.REFUND, PaymentStatus.CONFIRMED, '100.00'),
    ]);
    expect(s.confirmedRefunded).toBe('100.00');
    expect(s.netPaid).toBe('0.00');
    expect(s.remainingDue).toBe('100.00');
    expect(s.paymentStatus).toBe(OrderPaymentStatus.REFUNDED);
  });

  it('partial refund leaves positive net → PARTIALLY_PAID', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '100.00'),
      pay(PaymentKind.REFUND, PaymentStatus.CONFIRMED, '30.00'),
    ]);
    expect(s.netPaid).toBe('70.00');
    expect(s.remainingDue).toBe('30.00');
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
  });

  it('PENDING refund does not change money (no fake success)', () => {
    const s = computeOrderPaymentSummary(D('100.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '100.00'),
      pay(PaymentKind.REFUND, PaymentStatus.PENDING, '100.00'),
    ]);
    expect(s.confirmedRefunded).toBe('0.00');
    expect(s.netPaid).toBe('100.00');
    expect(s.pendingAmount).toBe('0.00');
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PAID);
  });

  it('uses decimal arithmetic without float drift', () => {
    const s = computeOrderPaymentSummary(D('0.30'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '0.10'),
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '0.20'),
    ]);
    expect(s.netPaid).toBe('0.30');
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PAID);
  });

  it('zero-total order with a payment is PAID', () => {
    const s = computeOrderPaymentSummary(D('0.00'), [
      pay(PaymentKind.CHARGE, PaymentStatus.CONFIRMED, '1.00'),
    ]);
    expect(s.paymentStatus).toBe(OrderPaymentStatus.PAID);
    expect(s.paymentProgressPercent).toBe(100);
  });
});
