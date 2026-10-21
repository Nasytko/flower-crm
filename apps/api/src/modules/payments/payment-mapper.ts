import {
  PaymentKind,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  type PaymentDto,
} from '@erp/shared';
import type { Prisma } from '@erp/database';

export const paymentInclude = {
  createdBy: { select: { name: true } },
  confirmedBy: { select: { name: true } },
} satisfies Prisma.PaymentInclude;

export type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

export function toPaymentDto(row: PaymentRow): PaymentDto {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind as PaymentKind,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    method: row.method as PaymentMethod,
    source: row.source as PaymentSource,
    status: row.status as PaymentStatus,
    parentPaymentId: row.parentPaymentId,
    externalTransactionId: row.externalTransactionId,
    externalProvider: row.externalProvider,
    idempotencyKey: row.idempotencyKey,
    cashShiftId: row.cashShiftId,
    isManual: row.isManual,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdBy.name,
    confirmedByUserId: row.confirmedByUserId,
    confirmedByName: row.confirmedBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}
