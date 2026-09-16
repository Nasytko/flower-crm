import type {
  BusinessTimeInfo,
  DiscountType,
  FulfillmentType,
  OrderDetail,
  OrderItemType,
  OrderListResult,
  OrderStatus,
} from '@erp/shared';
import { apiFetch } from './client';

export interface OrderItemInput {
  itemType: OrderItemType;
  productId?: string | null;
  bouquetId?: string | null;
  quantity: number;
  unitPrice?: string | null;
}

export interface CreateOrderInput {
  customerName?: string;
  customerPhone: string;
  fulfillmentType: FulfillmentType;
  fulfillmentDate: string;
  fulfillmentTimeFrom?: string | null;
  fulfillmentTimeTo?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddressText?: string | null;
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
  deliveryProvider?: string | null;
  deliveryProviderPlaceId?: string | null;
  deliveryComment?: string | null;
  orderComment?: string | null;
  discountType?: DiscountType | null;
  discountValue?: string | null;
  items: OrderItemInput[];
}

export type UpdateOrderInput = {
  expectedVersion: number;
} & Partial<Omit<CreateOrderInput, 'items'>> & {
    items?: OrderItemInput[];
  };

export interface ListOrdersParams {
  date?: string;
  status?: OrderStatus;
  fulfillmentType?: FulfillmentType;
  includeCancelled?: boolean;
  timeFrom?: string;
  timeTo?: string;
  withoutTime?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

export async function listOrders(params: ListOrdersParams = {}): Promise<OrderListResult> {
  const query = new URLSearchParams();
  if (params.date) query.set('date', params.date);
  if (params.status) query.set('status', params.status);
  if (params.fulfillmentType) query.set('fulfillmentType', params.fulfillmentType);
  if (params.includeCancelled) query.set('includeCancelled', 'true');
  if (params.timeFrom) query.set('timeFrom', params.timeFrom);
  if (params.timeTo) query.set('timeTo', params.timeTo);
  if (params.withoutTime) query.set('withoutTime', 'true');
  if (params.search) query.set('search', params.search);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<OrderListResult>(`/api/v1/orders${qs ? `?${qs}` : ''}`);
}

export async function getOrder(id: string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/api/v1/orders/${id}`);
}

export async function createOrder(input: CreateOrderInput): Promise<OrderDetail> {
  return apiFetch<OrderDetail>('/api/v1/orders', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateOrder(id: string, input: UpdateOrderInput): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/api/v1/orders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function changeOrderStatus(
  id: string,
  input: { status: OrderStatus; expectedVersion: number },
): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/api/v1/orders/${id}/status`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getBusinessTime(): Promise<BusinessTimeInfo> {
  return apiFetch<BusinessTimeInfo>('/api/v1/orders/business-time');
}
