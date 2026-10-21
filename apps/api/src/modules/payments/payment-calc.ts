import { Prisma } from '@erp/database';
import {
  OrderPaymentStatus,
  PaymentKind,
  PaymentStatus,
  type OrderPaymentSummaryDto,
} from '@erp/shared';

type Decimal = Prisma.Decimal;

export interface PaymentCalcInput {
  kind: PaymentKind | string;
  status: PaymentStatus | string;
  amount: Decimal;
}

export interface PaymentSummaryDecimals {
  orderTotal: Decimal;
  confirmedPaid: Decimal;
  confirmedRefunded: Decimal;
  netPaid: Decimal;
  pendingAmount: Decimal;
  remainingDue: Decimal;
  paymentProgressPercent: number;
  paymentStatus: OrderPaymentStatus;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Pure money math for an Order's payments. Decimal only.
 *
 * - CONFIRMED CHARGE   → confirmedPaid
 * - CONFIRMED REFUND   → confirmedRefunded
 * - PENDING CHARGE     → pendingAmount (never part of netPaid)
 * - everything else (FAILED / CANCELLED / PENDING REFUND / …) is ignored
 */
export function computePaymentSummaryDecimals(
  orderTotal: Decimal,
  payments: readonly PaymentCalcInput[],
): PaymentSummaryDecimals {
  let confirmedPaid = ZERO;
  let confirmedRefunded = ZERO;
  let pendingAmount = ZERO;

  for (const p of payments) {
    const kind = p.kind as PaymentKind;
    const status = p.status as PaymentStatus;
    if (kind === PaymentKind.CHARGE) {
      if (status === PaymentStatus.CONFIRMED) confirmedPaid = confirmedPaid.plus(p.amount);
      else if (status === PaymentStatus.PENDING) pendingAmount = pendingAmount.plus(p.amount);
    } else if (kind === PaymentKind.REFUND) {
      if (status === PaymentStatus.CONFIRMED) {
        confirmedRefunded = confirmedRefunded.plus(p.amount);
      }
    }
  }

  const netPaid = confirmedPaid.minus(confirmedRefunded);
  const remainingDue = Prisma.Decimal.max(ZERO, orderTotal.minus(netPaid));

  let paymentStatus: OrderPaymentStatus;
  if (confirmedRefunded.greaterThan(0) && netPaid.lessThanOrEqualTo(0)) {
    paymentStatus = confirmedRefunded.greaterThanOrEqualTo(confirmedPaid)
      ? OrderPaymentStatus.REFUNDED
      : OrderPaymentStatus.PARTIALLY_REFUNDED;
  } else if (confirmedRefunded.greaterThan(0) && remainingDue.greaterThan(0)) {
    // Full (or partial) pay then refund: debt reappears as remainingDue.
    paymentStatus = OrderPaymentStatus.PARTIALLY_REFUNDED;
  } else if (netPaid.lessThanOrEqualTo(0)) {
    paymentStatus = OrderPaymentStatus.UNPAID;
  } else if (remainingDue.lessThanOrEqualTo(0)) {
    paymentStatus = OrderPaymentStatus.PAID;
  } else {
    paymentStatus = OrderPaymentStatus.PARTIALLY_PAID;
  }

  let paymentProgressPercent = 0;
  if (netPaid.greaterThan(0)) {
    paymentProgressPercent = orderTotal.lessThanOrEqualTo(0)
      ? 100
      : Math.min(100, Math.floor(netPaid.div(orderTotal).mul(100).toNumber()));
  }

  return {
    orderTotal,
    confirmedPaid,
    confirmedRefunded,
    netPaid,
    pendingAmount,
    remainingDue,
    paymentProgressPercent,
    paymentStatus,
  };
}

/** Same as {@link computePaymentSummaryDecimals} but formatted for the API (2 dp strings). */
export function computeOrderPaymentSummary(
  orderTotal: Decimal,
  payments: readonly PaymentCalcInput[],
): OrderPaymentSummaryDto {
  const d = computePaymentSummaryDecimals(orderTotal, payments);
  return {
    orderTotal: toMoney(d.orderTotal),
    confirmedPaid: toMoney(d.confirmedPaid),
    confirmedRefunded: toMoney(d.confirmedRefunded),
    netPaid: toMoney(d.netPaid),
    pendingAmount: toMoney(d.pendingAmount),
    remainingDue: toMoney(d.remainingDue),
    paymentProgressPercent: d.paymentProgressPercent,
    paymentStatus: d.paymentStatus,
  };
}

export function toMoney(value: Decimal): string {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}
