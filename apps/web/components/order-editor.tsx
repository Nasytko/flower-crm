'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DiscountType,
  DISCOUNT_TYPE_LABELS_RU,
  FulfillmentType,
  FULFILLMENT_TYPE_LABELS_RU,
  OrderItemType,
  OrderStatus,
  Permission,
  ProductType,
  Unit,
  type BouquetListItem,
  type OrderDetail,
  type ProductListItem,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { listBouquets } from '@/lib/api/bouquets';
import { listProducts } from '@/lib/api/products';
import { createOrder, getBusinessTime, updateOrder } from '@/lib/api/orders';
import { ApiClientError } from '@/lib/api/client';
import { userFacingError } from '@/lib/api/error-messages';
import { queryKeys } from '@/lib/query-keys';
import { invalidateStockViews } from '@/lib/query-invalidation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProductPicker } from '@/components/ui/product-picker';
import { PhoneInput } from '@/components/ui/phone-input';
import { FilterSelect, SearchableSelect } from '@/components/ui/searchable-select';
import { StickyActionBar } from '@/components/ui/sticky-action-bar';
import { TimeSelect } from '@/components/ui/time-select';
import { isPhoneValidEnough, parseStoredPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';

interface LineDraft {
  key: string;
  itemType: OrderItemType;
  productId: string;
  bouquetId: string;
  quantity: string;
  unitPrice: string;
}

function money(value: string): number {
  const n = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n: number): string {
  return n.toFixed(2);
}

function emptyLine(): LineDraft {
  return {
    key: String(Date.now()) + Math.random().toString(16).slice(2),
    itemType: OrderItemType.PRODUCT,
    productId: '',
    bouquetId: '',
    quantity: '1',
    unitPrice: '',
  };
}

function linesFromOrder(order: OrderDetail): LineDraft[] {
  return order.items.map((item, index) => ({
    key: `${item.id}-${index}`,
    itemType: item.itemType,
    productId: item.productId ?? '',
    bouquetId: item.bouquetId ?? '',
    quantity: String(item.quantity),
    unitPrice: item.unitPrice,
  }));
}

function lineStockHint(
  line: LineDraft,
  productById: Map<string, ProductListItem>,
  bouquetById: Map<string, BouquetListItem>,
): ReactElement | null {
  const qty = Number.parseInt(line.quantity, 10);
  const qtyOk = Number.isInteger(qty) && qty >= 1;

  if (line.itemType === OrderItemType.PRODUCT) {
    if (!line.productId) return null;
    const product = productById.get(line.productId);
    const available = product?.stock?.availableQuantity;
    if (available == null) return null;
    if (qtyOk && qty > available) {
      return (
        <p className="text-xs text-danger-fg">
          Дефицит: нужно {qty}, доступно {available}
        </p>
      );
    }
    if (product?.type === ProductType.FLOWER) {
      return <p className="text-xs text-muted-foreground">Доступно: {available}</p>;
    }
    return null;
  }

  if (!line.bouquetId) return null;
  const bouquet = bouquetById.get(line.bouquetId);
  if (!bouquet) return null;
  const available = bouquet.availableBouquets;
  if (qtyOk && qty > available) {
    return (
      <p className="text-xs text-danger-fg">
        Дефицит: нужно {qty}, доступно {available}
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">Можно собрать: {available}</p>;
}

export function OrderEditor({
  mode,
  initial,
  defaultDate,
  readOnly = false,
}: {
  mode: 'create' | 'edit';
  initial?: OrderDetail;
  defaultDate?: string;
  readOnly?: boolean;
}): ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canDiscount = hasPermission(Permission.ORDERS_DISCOUNT);
  const canCreate = hasPermission(Permission.ORDERS_CREATE);
  const canUpdate = hasPermission(Permission.ORDERS_UPDATE);

  const editable =
    !readOnly &&
    ((mode === 'create' && canCreate) ||
      (mode === 'edit' && canUpdate && initial?.status === OrderStatus.NEW));

  const [customerName, setCustomerName] = useState(initial?.customerName ?? '');
  const [customerPhone, setCustomerPhone] = useState(initial?.customerPhone ?? '');
  const [fulfillmentType, setFulfillmentType] = useState<FulfillmentType>(
    initial?.fulfillmentType ?? FulfillmentType.PICKUP,
  );
  const [fulfillmentDate, setFulfillmentDate] = useState(
    initial?.fulfillmentDate ?? defaultDate ?? '',
  );
  const [timeFrom, setTimeFrom] = useState(initial?.fulfillmentTimeFrom ?? '');
  const [timeTo, setTimeTo] = useState(initial?.fulfillmentTimeTo ?? '');
  const [timeRangeChecked, setTimeRangeChecked] = useState(Boolean(initial?.fulfillmentTimeTo));
  const [recipientName, setRecipientName] = useState(initial?.recipientName ?? '');
  const [recipientPhone, setRecipientPhone] = useState(initial?.recipientPhone ?? '');
  const [deliveryAddress, setDeliveryAddress] = useState(initial?.deliveryAddressText ?? '');
  const [deliveryComment, setDeliveryComment] = useState(initial?.deliveryComment ?? '');
  const [orderComment, setOrderComment] = useState(initial?.orderComment ?? '');
  const [discountType, setDiscountType] = useState<DiscountType | ''>(initial?.discountType ?? '');
  const [discountValue, setDiscountValue] = useState(initial?.discountValue ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    initial ? linesFromOrder(initial) : [emptyLine()],
  );
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const businessTimeQuery = useQuery({
    queryKey: queryKeys.businessTime,
    queryFn: getBusinessTime,
    enabled: mode === 'create' && !defaultDate && !initial?.fulfillmentDate,
    staleTime: 60_000,
  });

  const resolvedFulfillmentDate =
    fulfillmentDate || businessTimeQuery.data?.businessDate || defaultDate || '';

  const productsQuery = useQuery({
    queryKey: queryKeys.products({ isActive: 'true', limit: 100 }),
    queryFn: () => listProducts({ isActive: 'true', limit: 100 }),
  });

  const bouquetsQuery = useQuery({
    queryKey: queryKeys.bouquets({ isActive: 'true', limit: 100 }),
    queryFn: () => listBouquets({ isActive: 'true', limit: 100 }),
  });

  const productItems = productsQuery.data?.items;
  const bouquetItems = bouquetsQuery.data?.items;

  const productById = useMemo(() => {
    const map = new Map<string, ProductListItem>();
    for (const p of productItems ?? []) map.set(p.id, p);
    return map;
  }, [productItems]);

  const bouquetById = useMemo(() => {
    const map = new Map<string, BouquetListItem>();
    for (const b of bouquetItems ?? []) map.set(b.id, b);
    return map;
  }, [bouquetItems]);

  const bouquetOptions = useMemo(() => {
    const map = new Map(
      (bouquetItems ?? []).map((b) => [
        b.id,
        {
          value: b.id,
          label: b.name,
          description: `${b.salePrice} BYN · ${b.compositionPreview}`,
          keywords: b.compositionPreview,
          disabled: !b.isActive,
        },
      ]),
    );
    if (initial) {
      for (const item of initial.items) {
        if (item.itemType === OrderItemType.BOUQUET && item.bouquetId && !map.has(item.bouquetId)) {
          map.set(item.bouquetId, {
            value: item.bouquetId,
            label: item.nameSnapshot,
            description: `${item.unitPrice} BYN`,
            keywords: item.compositionPreview ?? '',
            disabled: true,
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [bouquetItems, initial]);

  const pickerProducts = useMemo(() => {
    const map = new Map((productItems ?? []).map((p) => [p.id, p]));
    if (initial) {
      for (const item of initial.items) {
        if (item.itemType === OrderItemType.PRODUCT && item.productId && !map.has(item.productId)) {
          map.set(item.productId, {
            id: item.productId,
            name: item.nameSnapshot,
            sku: null,
            type: item.components[0]?.productTypeSnapshot ?? ProductType.FLOWER,
            description: null,
            unit: item.components[0]?.unitSnapshot ?? Unit.PIECE,
            salePrice: item.unitPrice,
            isActive: false,
            stock: null,
            createdAt: '',
            updatedAt: '',
          });
        }
      }
    }
    return [...map.values()];
  }, [productItems, initial]);

  const totals = useMemo(() => {
    let subtotal = 0;
    for (const line of lines) {
      const qty = Number.parseInt(line.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) continue;
      subtotal += money(line.unitPrice) * qty;
    }
    let discountAmount = 0;
    if (discountType && discountValue) {
      const dv = money(discountValue);
      if (discountType === DiscountType.PERCENT) {
        discountAmount = (subtotal * Math.min(Math.max(dv, 0), 100)) / 100;
      } else {
        discountAmount = Math.min(Math.max(dv, 0), subtotal);
      }
    }
    return {
      subtotal: formatMoney(subtotal),
      discountAmount: formatMoney(discountAmount),
      total: formatMoney(Math.max(subtotal - discountAmount, 0)),
    };
  }, [lines, discountType, discountValue]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const items = lines
        .filter((l) =>
          l.itemType === OrderItemType.PRODUCT ? Boolean(l.productId) : Boolean(l.bouquetId),
        )
        .map((l) => ({
          itemType: l.itemType,
          productId: l.itemType === OrderItemType.PRODUCT ? l.productId : null,
          bouquetId: l.itemType === OrderItemType.BOUQUET ? l.bouquetId : null,
          quantity: Number.parseInt(l.quantity, 10),
          unitPrice:
            canDiscount && l.unitPrice.trim() ? l.unitPrice.trim().replace(',', '.') : undefined,
        }));

      if (!resolvedFulfillmentDate) {
        throw new ApiClientError(400, {
          code: 'VALIDATION_ERROR',
          message: 'Укажите дату исполнения',
          details: {},
        });
      }
      const phoneParsed = parseStoredPhone(customerPhone);
      if (
        customerPhone.trim().length < 3 ||
        !isPhoneValidEnough(phoneParsed.countryId, phoneParsed.nationalDigits)
      ) {
        throw new ApiClientError(400, {
          code: 'VALIDATION_ERROR',
          message: 'Укажите полный номер телефона',
          details: {},
        });
      }
      if (items.length === 0) {
        throw new ApiClientError(400, {
          code: 'VALIDATION_ERROR',
          message: 'Добавьте хотя бы одну позицию',
          details: {},
        });
      }
      for (const item of items) {
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          throw new ApiClientError(400, {
            code: 'VALIDATION_ERROR',
            message: 'Количество должно быть положительным целым',
            details: {},
          });
        }
      }
      if (fulfillmentType === FulfillmentType.DELIVERY && !deliveryAddress.trim()) {
        throw new ApiClientError(400, {
          code: 'VALIDATION_ERROR',
          message: 'Для доставки укажите адрес',
          details: {},
        });
      }

      const payload: {
        customerName: string;
        customerPhone: string;
        fulfillmentType: FulfillmentType;
        fulfillmentDate: string;
        fulfillmentTimeFrom: string | null;
        fulfillmentTimeTo: string | null;
        recipientName: string | null;
        recipientPhone: string | null;
        deliveryAddressText: string | null;
        deliveryComment: string | null;
        orderComment: string | null;
        discountType?: DiscountType | null;
        discountValue?: string | null;
        items: typeof items;
      } = {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        fulfillmentType,
        fulfillmentDate: resolvedFulfillmentDate,
        fulfillmentTimeFrom: timeFrom.trim() || null,
        fulfillmentTimeTo: timeRangeChecked ? timeTo.trim() || null : null,
        recipientName: recipientName.trim() || null,
        recipientPhone: recipientPhone.trim() || null,
        deliveryAddressText:
          fulfillmentType === FulfillmentType.DELIVERY ? deliveryAddress.trim() || null : null,
        deliveryComment:
          fulfillmentType === FulfillmentType.DELIVERY ? deliveryComment.trim() || null : null,
        orderComment: orderComment.trim() || null,
        items,
      };

      if (canDiscount) {
        payload.discountType = discountType || null;
        payload.discountValue =
          discountType && discountValue.trim() ? discountValue.trim().replace(',', '.') : null;
      }

      if (mode === 'create') {
        return createOrder(payload);
      }
      return updateOrder(initial!.id, {
        expectedVersion: version,
        ...payload,
      });
    },
    onSuccess: async (detail) => {
      setMessage(mode === 'create' ? 'Заказ создан' : 'Заказ сохранён');
      setError(null);
      setVersion(detail.version);
      await invalidateStockViews(queryClient);
      if (mode === 'create') {
        router.push(`/app/orders?date=${detail.fulfillmentDate}`);
      } else {
        router.push(`/app/orders/${detail.id}`);
      }
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка сохранения'));
    },
  });

  if (mode === 'create' && !canCreate) {
    return <p className="text-sm text-muted-foreground">Недостаточно прав</p>;
  }

  return (
    <div className="space-y-6 pb-28">
      {mode === 'create' ? (
        <div>
          <button
            type="button"
            className="text-sm text-muted-foreground hover:underline"
            onClick={() =>
              router.push(
                resolvedFulfillmentDate
                  ? `/app/orders?date=${resolvedFulfillmentDate}`
                  : '/app/orders',
              )
            }
          >
            ← К заказам
          </button>
          <h1 className="mt-2 text-[2rem] font-semibold tracking-tight">Новый заказ</h1>
        </div>
      ) : null}

      {message ? (
        <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-6">
        <h2 className="text-base font-semibold">Клиент</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ord-phone">Телефон *</Label>
            <PhoneInput
              id="ord-phone"
              aria-label="Телефон"
              value={customerPhone}
              disabled={!editable}
              required
              onChange={setCustomerPhone}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ord-customer">Имя клиента</Label>
            <Input
              id="ord-customer"
              value={customerName}
              disabled={!editable}
              onChange={(e) => setCustomerName(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="ord-comment">Комментарий к заказу</Label>
            <Input
              id="ord-comment"
              value={orderComment}
              disabled={!editable}
              onChange={(e) => setOrderComment(e.target.value)}
              maxLength={2000}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-6">
        <h2 className="text-base font-semibold">Исполнение</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Тип *</Label>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Тип исполнения">
              {Object.values(FulfillmentType).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={!editable}
                  className={cn(
                    'min-h-11 rounded-2xl px-3 text-sm font-semibold transition-colors',
                    fulfillmentType === value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground',
                    !editable && 'opacity-70',
                  )}
                  onClick={() => setFulfillmentType(value)}
                >
                  {FULFILLMENT_TYPE_LABELS_RU[value]}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ord-date">Дата *</Label>
            <Input
              id="ord-date"
              type="date"
              value={resolvedFulfillmentDate}
              disabled={!editable}
              onChange={(e) => setFulfillmentDate(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl bg-muted/50 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-[var(--primary)]"
                checked={timeRangeChecked}
                disabled={!editable}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setTimeRangeChecked(checked);
                  if (!checked) setTimeTo('');
                }}
              />
              <span>Промежуток времени</span>
            </label>
          </div>
          {timeRangeChecked ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="ord-time-from">С</Label>
                <TimeSelect
                  id="ord-time-from"
                  aria-label="Время с"
                  value={timeFrom}
                  disabled={!editable}
                  onChange={setTimeFrom}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ord-time-to">До</Label>
                <TimeSelect
                  id="ord-time-to"
                  aria-label="Время до"
                  value={timeTo}
                  disabled={!editable}
                  onChange={setTimeTo}
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="ord-time-from">Время</Label>
              <TimeSelect
                id="ord-time-from"
                aria-label="Время"
                value={timeFrom}
                disabled={!editable}
                onChange={setTimeFrom}
              />
            </div>
          )}
          <div className="space-y-2 sm:col-span-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl bg-muted/50 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-[var(--primary)]"
                checked={!recipientName.trim() && !recipientPhone.trim()}
                disabled={!editable}
                onChange={(e) => {
                  if (e.target.checked) {
                    setRecipientName('');
                    setRecipientPhone('');
                  } else {
                    setRecipientName(customerName);
                    setRecipientPhone(customerPhone);
                  }
                }}
              />
              <span>Получатель совпадает с заказчиком</span>
            </label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ord-recipient">Получатель</Label>
            <Input
              id="ord-recipient"
              value={recipientName}
              disabled={!editable}
              onChange={(e) => setRecipientName(e.target.value)}
              placeholder="Если отличается от клиента"
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ord-recipient-phone">Телефон получателя</Label>
            <PhoneInput
              id="ord-recipient-phone"
              aria-label="Телефон получателя"
              value={recipientPhone}
              disabled={!editable}
              onChange={setRecipientPhone}
            />
          </div>
          {fulfillmentType === FulfillmentType.DELIVERY ? (
            <>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ord-address">Адрес доставки *</Label>
                <Input
                  id="ord-address"
                  value={deliveryAddress}
                  disabled={!editable}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  maxLength={500}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ord-delivery-comment">Комментарий к доставке</Label>
                <Input
                  id="ord-delivery-comment"
                  value={deliveryComment}
                  disabled={!editable}
                  onChange={(e) => setDeliveryComment(e.target.value)}
                  maxLength={2000}
                />
              </div>
            </>
          ) : null}
        </div>
      </section>

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Состав</h2>
          {editable ? (
            <Button
              type="button"
              variant="soft"
              size="sm"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
            >
              + Позиция
            </Button>
          ) : null}
        </div>

        <div className="space-y-3">
          {lines.map((line, index) => {
            const catalogPrice =
              line.itemType === OrderItemType.PRODUCT
                ? productById.get(line.productId)?.salePrice
                : bouquetById.get(line.bouquetId)?.salePrice;
            const stockHint = lineStockHint(line, productById, bouquetById);

            return (
              <div
                key={line.key}
                className="grid gap-2 rounded-2xl border border-border/80 bg-muted/20 p-3 lg:grid-cols-[140px_minmax(0,1fr)_auto_110px_auto] lg:items-start"
              >
                <FilterSelect
                  ariaLabel={`Тип позиции ${index + 1}`}
                  value={line.itemType}
                  onChange={(next) => {
                    const itemType = next as OrderItemType;
                    setLines((prev) =>
                      prev.map((l, i) =>
                        i === index
                          ? {
                              ...l,
                              itemType,
                              productId: '',
                              bouquetId: '',
                              unitPrice: '',
                            }
                          : l,
                      ),
                    );
                  }}
                  options={[
                    { value: OrderItemType.PRODUCT, label: 'Товар' },
                    { value: OrderItemType.BOUQUET, label: 'Букет' },
                  ]}
                  className={!editable ? 'pointer-events-none opacity-70' : undefined}
                />
                <div className="min-w-0 space-y-1">
                  {line.itemType === OrderItemType.PRODUCT ? (
                    <ProductPicker
                      products={pickerProducts}
                      value={line.productId}
                      disabled={!editable}
                      showStock={true}
                      placeholder="Выберите товар…"
                      onChange={(productId) => {
                        const product = productById.get(productId);
                        setLines((prev) =>
                          prev.map((l, i) =>
                            i === index
                              ? {
                                  ...l,
                                  productId,
                                  bouquetId: '',
                                  unitPrice: product?.salePrice ?? l.unitPrice,
                                }
                              : l,
                          ),
                        );
                      }}
                    />
                  ) : (
                    <SearchableSelect
                      value={line.bouquetId}
                      onChange={(bouquetId) => {
                        const bouquet = bouquetById.get(bouquetId);
                        setLines((prev) =>
                          prev.map((l, i) =>
                            i === index
                              ? {
                                  ...l,
                                  bouquetId,
                                  productId: '',
                                  unitPrice: bouquet?.salePrice ?? l.unitPrice,
                                }
                              : l,
                          ),
                        );
                      }}
                      options={bouquetOptions}
                      disabled={!editable}
                      placeholder="Выберите букет…"
                      searchPlaceholder="Поиск букета…"
                      emptyText="Букеты не найдены"
                      clearable={false}
                    />
                  )}
                  {stockHint}
                </div>
                <div className="inline-flex h-11 items-center rounded-2xl border border-border bg-card">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-2xl"
                    disabled={!editable}
                    aria-label="Уменьшить количество"
                    onClick={() => {
                      setLines((prev) =>
                        prev.map((l, i) => {
                          if (i !== index) return l;
                          const n = Math.max(1, (Number.parseInt(l.quantity, 10) || 1) - 1);
                          return { ...l, quantity: String(n) };
                        }),
                      );
                    }}
                  >
                    −
                  </Button>
                  <Input
                    inputMode="numeric"
                    className="h-11 w-12 border-0 bg-transparent p-0 text-center tabular-nums shadow-none focus-visible:ring-0"
                    value={line.quantity}
                    disabled={!editable}
                    aria-label="Количество"
                    onChange={(e) => {
                      const quantity = e.target.value.replace(/[^\d]/g, '');
                      setLines((prev) =>
                        prev.map((l, i) => (i === index ? { ...l, quantity } : l)),
                      );
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-2xl"
                    disabled={!editable}
                    aria-label="Увеличить количество"
                    onClick={() => {
                      setLines((prev) =>
                        prev.map((l, i) => {
                          if (i !== index) return l;
                          const n = (Number.parseInt(l.quantity, 10) || 0) + 1;
                          return { ...l, quantity: String(n) };
                        }),
                      );
                    }}
                  >
                    +
                  </Button>
                </div>
                <Input
                  inputMode="decimal"
                  className="min-h-11"
                  value={line.unitPrice}
                  disabled={!editable || !canDiscount}
                  aria-label="Цена"
                  title={
                    canDiscount
                      ? 'Цена за единицу'
                      : catalogPrice
                        ? `Цена каталога: ${catalogPrice}`
                        : 'Цена из каталога'
                  }
                  onChange={(e) => {
                    const unitPrice = e.target.value;
                    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, unitPrice } : l)));
                  }}
                />
                {editable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    aria-label="Удалить позицию"
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Удалить
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-6">
        <h2 className="text-base font-semibold">Скидка и итоги</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {canDiscount ? (
            <>
              <div className="space-y-2">
                <Label>Тип скидки</Label>
                <FilterSelect
                  ariaLabel="Тип скидки"
                  value={discountType || 'none'}
                  onChange={(v) => setDiscountType(v === 'none' ? '' : (v as DiscountType))}
                  options={[
                    { value: 'none', label: 'Без скидки' },
                    ...Object.values(DiscountType).map((value) => ({
                      value,
                      label: DISCOUNT_TYPE_LABELS_RU[value],
                    })),
                  ]}
                  className={!editable ? 'pointer-events-none opacity-70' : undefined}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ord-discount">Значение</Label>
                <Input
                  id="ord-discount"
                  value={discountValue}
                  disabled={!editable || !discountType}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  inputMode="decimal"
                />
              </div>
            </>
          ) : initial?.discountType && initial.discountValue ? (
            <div className="space-y-1 text-sm sm:col-span-2">
              <p className="text-muted-foreground">Скидка (только просмотр)</p>
              <p className="font-medium">
                {DISCOUNT_TYPE_LABELS_RU[initial.discountType]}: {initial.discountValue}
                {initial.discountType === DiscountType.PERCENT ? '%' : ' BYN'}
                {initial.discountAmount ? ` (−${initial.discountAmount} BYN)` : ''}
              </p>
            </div>
          ) : null}
          <div className="space-y-1 text-sm sm:col-span-3 sm:pt-2">
            <div className="flex justify-between gap-4 text-muted-foreground">
              <span>Сумма</span>
              <span className="tabular-nums text-foreground">{totals.subtotal} BYN</span>
            </div>
            <div className="flex justify-between gap-4 text-muted-foreground">
              <span>Скидка</span>
              <span className="tabular-nums text-foreground">{totals.discountAmount} BYN</span>
            </div>
            <div className="flex justify-between gap-4 border-t border-border pt-2 text-base font-semibold">
              <span>Итого</span>
              <span className="tabular-nums">{totals.total} BYN</span>
            </div>
            {mode === 'edit' && initial && readOnly ? (
              <p className="pt-1 text-xs text-muted-foreground">
                Итого по заказу: {initial.total} BYN
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {editable ? (
        <StickyActionBar>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            onClick={() =>
              router.push(
                mode === 'edit' && initial
                  ? `/app/orders?date=${initial.fulfillmentDate}`
                  : resolvedFulfillmentDate
                    ? `/app/orders?date=${resolvedFulfillmentDate}`
                    : '/app/orders',
              )
            }
          >
            Отмена
          </Button>
          <Button
            type="button"
            className="min-h-11 w-full sm:w-auto"
            disabled={saveMutation.isPending}
            onClick={() => {
              setError(null);
              saveMutation.mutate();
            }}
          >
            Сохранить
          </Button>
        </StickyActionBar>
      ) : null}
    </div>
  );
}
