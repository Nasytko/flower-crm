import type {
  DiscountType,
  FulfillmentType,
  OrderFulfillmentMode,
  PosCartDto,
  PosCartLineType,
  PosCartListItem,
  PosCartStatus,
  PosCatalogItemDto,
  PosPriceMode,
} from '@erp/shared';
import { apiFetch } from './client';

export interface PosComponentInput {
  productId: string;
  quantity: number;
  priceMode?: PosPriceMode;
}

export interface AddPosLineInput {
  expectedVersion?: number;
  lineType: PosCartLineType;
  productId?: string;
  bouquetTemplateId?: string;
  assembledBouquetId?: string;
  parentLineId?: string;
  quantity?: number;
  copies?: number;
  components?: PosComponentInput[];
  unitPrice?: string;
  priceOverrideReason?: string;
  nameSnapshot?: string;
  priceMode?: PosPriceMode;
}

export interface UpdatePosLineInput {
  expectedVersion: number;
  quantity?: number;
  nameSnapshot?: string;
  unitPrice?: string;
  priceOverrideReason?: string | null;
  priceMode?: PosPriceMode;
  lineDiscountType?: DiscountType | null;
  lineDiscountValue?: string | null;
  components?: PosComponentInput[];
  acceptRecommendedPrice?: boolean;
}

export interface UpdatePosDiscountInput {
  expectedVersion: number;
  discountType: DiscountType | null;
  discountValue: string | null;
}

export interface ConfirmPosCartInput {
  expectedVersion: number;
  idempotencyKey: string;
  fulfillmentMode: OrderFulfillmentMode;
  customerName?: string;
  customerPhone?: string;
  fulfillmentType?: FulfillmentType;
  fulfillmentDate?: string;
  fulfillmentTimeFrom?: string | null;
  fulfillmentTimeTo?: string | null;
  orderComment?: string | null;
}

export interface PosConfirmResult {
  cart: PosCartDto;
  orderId: string;
  orderNumber: string;
}

export async function createCart(): Promise<PosCartDto> {
  return apiFetch<PosCartDto>('/api/v1/pos/carts', { method: 'POST' });
}

export async function listCarts(status?: PosCartStatus): Promise<PosCartListItem[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<PosCartListItem[]>(`/api/v1/pos/carts${qs}`);
}

export async function getCart(id: string): Promise<PosCartDto> {
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${id}`);
}

export async function addLine(cartId: string, input: AddPosLineInput): Promise<PosCartDto> {
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${cartId}/lines`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateLine(
  cartId: string,
  lineId: string,
  input: UpdatePosLineInput,
): Promise<PosCartDto> {
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${cartId}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function removeLine(
  cartId: string,
  lineId: string,
  expectedVersion?: number,
): Promise<PosCartDto> {
  const qs = expectedVersion ? `?expectedVersion=${expectedVersion}` : '';
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${cartId}/lines/${lineId}${qs}`, {
    method: 'DELETE',
  });
}

export async function updateDiscount(
  cartId: string,
  input: UpdatePosDiscountInput,
): Promise<PosCartDto> {
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${cartId}/discount`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function parkCart(
  cartId: string,
  input: { expectedVersion: number; parkedLabel?: string | null },
): Promise<PosCartDto> {
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${cartId}/park`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function resumeCart(cartId: string, expectedVersion: number): Promise<PosCartDto> {
  return apiFetch<PosCartDto>(`/api/v1/pos/carts/${cartId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ expectedVersion }),
  });
}

export async function confirmCart(
  cartId: string,
  input: ConfirmPosCartInput,
): Promise<PosConfirmResult> {
  return apiFetch<PosConfirmResult>(`/api/v1/pos/carts/${cartId}/confirm`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function quickSellCart(
  cartId: string,
  input: {
    expectedVersion: number;
    idempotencyKey: string;
    payments: Array<{ method: 'CASH' | 'CARD_TERMINAL'; amount: string; idempotencyKey: string }>;
    issue?: boolean;
    customerName?: string;
    customerPhone?: string;
  },
): Promise<import('@erp/shared').PosQuickSellResultDto> {
  return apiFetch(`/api/v1/pos/carts/${cartId}/quick-sell`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function searchCatalog(q: string): Promise<PosCatalogItemDto[]> {
  return apiFetch<PosCatalogItemDto[]>(`/api/v1/pos/catalog/search?q=${encodeURIComponent(q)}`);
}

export async function popularCatalog(): Promise<PosCatalogItemDto[]> {
  return apiFetch<PosCatalogItemDto[]>('/api/v1/pos/catalog/popular');
}
