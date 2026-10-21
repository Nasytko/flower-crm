import type {
  OrderPaymentsDto,
  PaymentMethod,
  PaymentMutationResultDto,
  PaymentSource,
} from '@erp/shared';
import { apiFetch } from './client';

export async function listOrderPayments(orderId: string): Promise<OrderPaymentsDto> {
  return apiFetch<OrderPaymentsDto>(`/api/v1/orders/${orderId}/payments`);
}

export async function createOrderPayment(
  orderId: string,
  body: {
    amount: string;
    method: PaymentMethod;
    source?: PaymentSource;
    idempotencyKey: string;
    confirmImmediately?: boolean;
    isManual?: boolean;
    externalTransactionId?: string | null;
    externalProvider?: string | null;
    note?: string | null;
  },
): Promise<PaymentMutationResultDto> {
  return apiFetch<PaymentMutationResultDto>(`/api/v1/orders/${orderId}/payments`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function confirmPayment(
  paymentId: string,
  body: { note?: string | null } = {},
): Promise<PaymentMutationResultDto> {
  return apiFetch<PaymentMutationResultDto>(`/api/v1/payments/${paymentId}/confirm`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function refundPayment(
  paymentId: string,
  body: { amount: string; idempotencyKey: string; note?: string | null },
): Promise<PaymentMutationResultDto> {
  return apiFetch<PaymentMutationResultDto>(`/api/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
