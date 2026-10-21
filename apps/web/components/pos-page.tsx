'use client';

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, Search, Trash2 } from 'lucide-react';
import {
  DISCOUNT_TYPE_LABELS_RU,
  DiscountType,
  ORDER_FULFILLMENT_MODE_LABELS_RU,
  OrderFulfillmentMode,
  POS_PRICE_MODE_LABELS_RU,
  PaymentMethod,
  Permission,
  PosCartLineType,
  PosCartStatus,
  PosPriceMode,
  ProductType,
  UNIT_LABELS_RU,
  type PosCartDto,
  type PosCartLineDto,
  type PosCartListItem,
  type PosCatalogItemDto,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiClientError } from '@/lib/api/client';
import { userFacingError } from '@/lib/api/error-messages';
import {
  addLine,
  confirmCart,
  createCart,
  getCart,
  listCarts,
  parkCart,
  popularCatalog,
  quickSellCart,
  removeLine,
  resumeCart,
  searchCatalog,
  updateDiscount,
  updateLine,
  type AddPosLineInput,
  type PosComponentInput,
  type UpdatePosLineInput,
} from '@/lib/api/pos';
import { getCurrentCashShift, openCashShift } from '@/lib/api/cash';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { PhoneInput } from '@/components/ui/phone-input';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { cn } from '@/lib/utils';

type CatalogTab = 'ALL' | 'BOUQUET' | 'PRODUCT' | 'SERVICE' | 'ASSEMBLED';

const TABS: Array<{ id: CatalogTab; label: string }> = [
  { id: 'ALL', label: 'Все' },
  { id: 'BOUQUET', label: 'Букеты' },
  { id: 'PRODUCT', label: 'Цветы' },
  { id: 'SERVICE', label: 'Услуги' },
  { id: 'ASSEMBLED', label: 'Витрина' },
];

const KIND_LABELS_RU: Record<PosCatalogItemDto['kind'], string> = {
  BOUQUET: 'Букет',
  PRODUCT: 'Цветок',
  SERVICE: 'Услуга',
  ASSEMBLED: 'Витрина',
};

const SELECT_CLASS =
  'h-11 w-full rounded-2xl border border-border bg-card px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:text-sm';

const CUSTOM_BOUQUET_NAME = 'Индивидуальный букет';

function money(value: string | null | undefined): string {
  return `${value ?? '0.00'} BYN`;
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function isBouquetLine(line: PosCartLineDto): boolean {
  return (
    line.lineType === PosCartLineType.BOUQUET_TEMPLATE ||
    line.lineType === PosCartLineType.BOUQUET_CUSTOM
  );
}

function catalogLineInput(item: PosCatalogItemDto, expectedVersion: number): AddPosLineInput {
  switch (item.kind) {
    case 'BOUQUET':
      return {
        expectedVersion,
        lineType: PosCartLineType.BOUQUET_TEMPLATE,
        bouquetTemplateId: item.id,
        copies: 1,
      };
    case 'PRODUCT':
      return {
        expectedVersion,
        lineType: PosCartLineType.PRODUCT,
        productId: item.id,
        quantity: 1,
      };
    case 'SERVICE':
      return {
        expectedVersion,
        lineType: PosCartLineType.SERVICE,
        productId: item.id,
        quantity: 1,
      };
    case 'ASSEMBLED':
      return {
        expectedVersion,
        lineType: PosCartLineType.ASSEMBLED,
        assembledBouquetId: item.id,
      };
  }
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function ErrorBanner({ message }: { message: string | null }): ReactElement | null {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

/** Product search over the POS catalog (flowers + optionally services). */
function CatalogProductSearch({
  allowServices,
  onPick,
  placeholder = 'Поиск цветка или услуги…',
}: {
  allowServices: boolean;
  onPick: (item: PosCatalogItemDto) => void;
  placeholder?: string;
}): ReactElement {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const query = useQuery({
    queryKey: queryKeys.posCatalogSearch(term),
    queryFn: () => searchCatalog(term),
    enabled: term.length > 0,
  });
  const items = (query.data ?? []).filter(
    (i) => i.kind === 'PRODUCT' || (allowServices && i.kind === 'SERVICE'),
  );

  return (
    <div className="space-y-2">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label="Поиск товара"
      />
      {term.length > 0 ? (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-2xl border border-border">
          {query.isLoading ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">Поиск…</li>
          ) : items.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">Ничего не найдено</li>
          ) : (
            items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-muted active:bg-muted/80"
                  onClick={() => {
                    onPick(item);
                    setQ('');
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {KIND_LABELS_RU[item.kind]}
                      {item.availableQuantity !== null
                        ? ` · доступно: ${item.availableQuantity}`
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {item.salePrice ? money(item.salePrice) : ''}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

interface DraftComponent {
  productId: string;
  name: string;
  type: ProductType;
  unitLabel: string | null;
  quantity: number;
  priceMode: PosPriceMode;
  available: number | null;
}

function draftFromLine(line: PosCartLineDto): DraftComponent[] {
  return line.components.map((c) => ({
    productId: c.productId,
    name: c.productNameSnapshot,
    type: c.productTypeSnapshot,
    unitLabel: UNIT_LABELS_RU[c.unitSnapshot] ?? null,
    quantity: c.quantity,
    priceMode: c.priceMode,
    available: c.availableQuantity,
  }));
}

function draftFromCatalogItem(item: PosCatalogItemDto): DraftComponent {
  const isService = item.kind === 'SERVICE';
  return {
    productId: item.id,
    name: item.name,
    type: isService ? ProductType.SERVICE : ProductType.FLOWER,
    unitLabel: null,
    quantity: 1,
    priceMode: PosPriceMode.ADDITIONAL,
    available: item.availableQuantity,
  };
}

function toComponentInputs(draft: DraftComponent[]): PosComponentInput[] {
  return draft.map((d) => ({
    productId: d.productId,
    quantity: d.quantity,
    ...(d.type === ProductType.SERVICE ? { priceMode: d.priceMode } : {}),
  }));
}

function BouquetEditorDialog({
  line,
  canOverridePrice,
  busy,
  error,
  onClose,
  onSave,
}: {
  line: PosCartLineDto;
  canOverridePrice: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: Omit<UpdatePosLineInput, 'expectedVersion'>) => void;
}): ReactElement {
  const [draft, setDraft] = useState<DraftComponent[]>(() => draftFromLine(line));
  const [priceInput, setPriceInput] = useState(line.unitPrice);
  const [priceTouched, setPriceTouched] = useState(false);
  const [acceptRecommended, setAcceptRecommended] = useState(false);
  const [reason, setReason] = useState(line.priceOverrideReason ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const priceDiffers = line.unitPrice !== line.recommendedUnitPrice;

  const setQuantity = (productId: string, quantity: number) => {
    setDraft((prev) =>
      prev.map((d) =>
        d.productId === productId ? { ...d, quantity: Math.max(1, Math.min(10_000, quantity)) } : d,
      ),
    );
  };

  const addComponent = (item: PosCatalogItemDto) => {
    setDraft((prev) => {
      const existing = prev.find((d) => d.productId === item.id);
      if (existing) {
        return prev.map((d) => (d.productId === item.id ? { ...d, quantity: d.quantity + 1 } : d));
      }
      return [...prev, draftFromCatalogItem(item)];
    });
  };

  const save = () => {
    if (!draft.some((d) => d.type === ProductType.FLOWER)) {
      setLocalError('В составе букета нужен хотя бы один цветок');
      return;
    }
    setLocalError(null);
    const patch: Omit<UpdatePosLineInput, 'expectedVersion'> = {
      components: toComponentInputs(draft),
    };
    if (acceptRecommended) {
      patch.acceptRecommendedPrice = true;
    } else if (priceTouched && canOverridePrice && priceInput.trim() !== line.unitPrice) {
      patch.unitPrice = priceInput.trim().replace(',', '.');
      patch.priceOverrideReason = reason.trim() || null;
    }
    onSave(patch);
  };

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      size="lg"
      title={line.nameSnapshot}
      description="Состав и цена букета"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <ErrorBanner message={localError ?? error} />

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Состав</h3>
          {draft.length === 0 ? (
            <p className="text-sm text-muted-foreground">Состав пуст — добавьте цветы.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {draft.map((d) => {
                const short =
                  d.type === ProductType.FLOWER && d.available !== null && d.quantity > d.available;
                return (
                  <li key={d.productId} className="space-y-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{d.name}</p>
                        <p
                          className={cn(
                            'text-xs',
                            short ? 'text-destructive' : 'text-muted-foreground',
                          )}
                        >
                          {d.type === ProductType.FLOWER
                            ? `Доступно: ${d.available ?? 0}${d.unitLabel ? ` ${d.unitLabel}` : ''}${
                                short ? ' — не хватает' : ''
                              }`
                            : 'Услуга'}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Убрать ${d.name}`}
                        onClick={() =>
                          setDraft((prev) => prev.filter((x) => x.productId !== d.productId))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Меньше"
                        onClick={() => setQuantity(d.productId, d.quantity - 1)}
                        disabled={d.quantity <= 1}
                      >
                        <Minus className="size-4" />
                      </Button>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={10_000}
                        value={d.quantity}
                        onChange={(e) => setQuantity(d.productId, Number(e.target.value) || 1)}
                        className="h-11 w-20 text-center"
                        aria-label={`Количество: ${d.name}`}
                      />
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Больше"
                        onClick={() => setQuantity(d.productId, d.quantity + 1)}
                      >
                        <Plus className="size-4" />
                      </Button>
                      {d.type === ProductType.SERVICE ? (
                        <select
                          className={cn(SELECT_CLASS, 'w-auto min-w-[10rem] flex-1')}
                          value={d.priceMode}
                          aria-label={`Тип цены: ${d.name}`}
                          onChange={(e) =>
                            setDraft((prev) =>
                              prev.map((x) =>
                                x.productId === d.productId
                                  ? { ...x, priceMode: e.target.value as PosPriceMode }
                                  : x,
                              ),
                            )
                          }
                        >
                          {Object.values(PosPriceMode).map((mode) => (
                            <option key={mode} value={mode}>
                              {POS_PRICE_MODE_LABELS_RU[mode]}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <CatalogProductSearch allowServices onPick={addComponent} />
        </section>

        <section className="space-y-3 rounded-2xl border border-border bg-muted/40 p-4">
          <h3 className="text-sm font-semibold">Цена</h3>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Рекомендованная</dt>
            <dd className="text-right font-medium">{money(line.recommendedUnitPrice)}</dd>
            <dt className="text-muted-foreground">Текущая</dt>
            <dd className="text-right font-medium">
              {money(line.unitPrice)}
              {line.priceOverridden ? (
                <span className="ml-2 text-xs text-muted-foreground">(изменена)</span>
              ) : null}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            Рекомендованная цена пересчитается после сохранения состава.
          </p>
          {canOverridePrice ? (
            <div className="space-y-2">
              <Label htmlFor="pos-price">Цена за букет, BYN</Label>
              <Input
                id="pos-price"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => {
                  setPriceInput(e.target.value);
                  setPriceTouched(true);
                  setAcceptRecommended(false);
                }}
              />
              {priceTouched && priceInput.trim() !== line.unitPrice ? (
                <>
                  <Label htmlFor="pos-price-reason">Причина изменения цены</Label>
                  <Input
                    id="pos-price-reason"
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </>
              ) : null}
            </div>
          ) : null}
          {priceDiffers || priceTouched ? (
            <Button
              variant={acceptRecommended ? 'default' : 'outline'}
              onClick={() => {
                setAcceptRecommended(true);
                setPriceTouched(false);
                setPriceInput(line.recommendedUnitPrice);
              }}
            >
              {acceptRecommended ? 'Будет принята рекомендованная' : 'Принять рекомендованную'}
            </Button>
          ) : null}
        </section>
      </div>
    </ResponsiveDialog>
  );
}

function CustomBouquetDialog({
  busy,
  error,
  onClose,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (flower: PosCatalogItemDto) => void;
}): ReactElement {
  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title={CUSTOM_BOUQUET_NAME}
      description="Выберите первый цветок — остальной состав настроите в редакторе."
    >
      <div className="space-y-3">
        <ErrorBanner message={error} />
        {busy ? <p className="text-sm text-muted-foreground">Создание…</p> : null}
        <CatalogProductSearch
          allowServices={false}
          placeholder="Поиск цветка…"
          onPick={(item) => {
            if (!busy) onCreate(item);
          }}
        />
      </div>
    </ResponsiveDialog>
  );
}

function CartListDialog({
  carts,
  activeId,
  busy,
  error,
  onClose,
  onResume,
  onSwitch,
}: {
  carts: PosCartListItem[];
  activeId: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onResume: (cart: PosCartListItem) => void;
  onSwitch: (id: string) => void;
}): ReactElement {
  return (
    <ResponsiveDialog open onClose={onClose} title="Отложенные корзины" size="md">
      <div className="space-y-3">
        <ErrorBanner message={error} />
        {carts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Нет отложенных корзин.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border">
            {carts.map((c) => {
              const parked = c.status === PosCartStatus.PARKED;
              return (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium">
                      {parked ? c.parkedLabel || 'Без названия' : 'Открытая корзина'}
                      {c.id === activeId ? ' (текущая)' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Позиций: {c.lineCount} · {money(c.total)}
                    </p>
                  </div>
                  {c.id === activeId ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => (parked ? onResume(c) : onSwitch(c.id))}
                    >
                      {parked ? 'Продолжить' : 'Открыть'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function ParkDialog({
  busy,
  error,
  onClose,
  onPark,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPark: (label: string) => void;
}): ReactElement {
  const [label, setLabel] = useState('');
  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      size="sm"
      title="Отложить корзину"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => onPark(label.trim())} disabled={busy}>
            {busy ? 'Сохранение…' : 'Отложить'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ErrorBanner message={error} />
        <Label htmlFor="pos-park-label">Название (необязательно)</Label>
        <Input
          id="pos-park-label"
          value={label}
          maxLength={200}
          placeholder="Например, клиент в синем пальто"
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
    </ResponsiveDialog>
  );
}

function DiscountDialog({
  cart,
  busy,
  error,
  onClose,
  onApply,
}: {
  cart: PosCartDto;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApply: (type: DiscountType | null, value: string | null) => void;
}): ReactElement {
  const [type, setType] = useState<DiscountType>(cart.discountType ?? DiscountType.PERCENT);
  const [value, setValue] = useState(cart.discountValue ?? '');
  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      size="sm"
      title="Скидка на корзину"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {cart.discountType ? (
            <Button variant="outline" disabled={busy} onClick={() => onApply(null, null)}>
              Убрать скидку
            </Button>
          ) : null}
          <Button
            disabled={busy || !value.trim()}
            onClick={() => onApply(type, value.trim().replace(',', '.'))}
          >
            Применить
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <ErrorBanner message={error} />
        <Label htmlFor="pos-discount-type">Тип скидки</Label>
        <select
          id="pos-discount-type"
          className={SELECT_CLASS}
          value={type}
          onChange={(e) => setType(e.target.value as DiscountType)}
        >
          {Object.values(DiscountType).map((t) => (
            <option key={t} value={t}>
              {DISCOUNT_TYPE_LABELS_RU[t]}
              {t === DiscountType.PERCENT ? ' (%)' : ' (BYN)'}
            </option>
          ))}
        </select>
        <Label htmlFor="pos-discount-value">Величина</Label>
        <Input
          id="pos-discount-value"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </ResponsiveDialog>
  );
}

function PosConfirmDialog({
  cart,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  cart: PosCartDto;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (input: Parameters<typeof confirmCart>[1]) => void;
}): ReactElement {
  // Mounted only while open, so the key is stable across retries of one confirmation.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [mode, setMode] = useState<OrderFulfillmentMode>(OrderFulfillmentMode.WALK_IN);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState('');
  const [comment, setComment] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const scheduled = mode === OrderFulfillmentMode.SCHEDULED;

  const submit = () => {
    if (scheduled && phone.trim().length < 3) {
      setLocalError('Для предзаказа укажите телефон клиента');
      return;
    }
    if (scheduled && !date) {
      setLocalError('Для предзаказа укажите дату выполнения');
      return;
    }
    setLocalError(null);
    onConfirm({
      expectedVersion: cart.version,
      idempotencyKey,
      fulfillmentMode: mode,
      customerName: customerName.trim() || undefined,
      customerPhone: phone.trim().length >= 3 ? phone.trim() : undefined,
      fulfillmentDate: scheduled ? date : undefined,
      orderComment: comment.trim() || null,
    });
  };

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      size="md"
      title="Оформить продажу"
      description={`Итого: ${money(cart.total)}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Оформление…' : 'Оформить'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={localError ?? error} />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Тип продажи</legend>
          {Object.values(OrderFulfillmentMode).map((m) => (
            <label
              key={m}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border px-4 py-2 text-sm',
                mode === m ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="pos-fulfillment-mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                className="size-4"
              />
              {ORDER_FULFILLMENT_MODE_LABELS_RU[m]}
            </label>
          ))}
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="pos-customer-name">Имя клиента (необязательно)</Label>
          <Input
            id="pos-customer-name"
            value={customerName}
            maxLength={200}
            onChange={(e) => setCustomerName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pos-customer-phone">Телефон{scheduled ? '' : ' (необязательно)'}</Label>
          <PhoneInput id="pos-customer-phone" value={phone} onChange={setPhone} />
        </div>
        {scheduled ? (
          <div className="space-y-2">
            <Label htmlFor="pos-date">Дата выполнения</Label>
            <Input
              id="pos-date"
              type="date"
              min={todayIso()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="pos-comment">Комментарий к заказу</Label>
          <Input
            id="pos-comment"
            value={comment}
            maxLength={2000}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function CartLineRow({
  line,
  busy,
  onRemove,
  onEdit,
  onQuantity,
}: {
  line: PosCartLineDto;
  busy: boolean;
  onRemove: () => void;
  onEdit: () => void;
  onQuantity: (quantity: number) => void;
}): ReactElement {
  const bouquet = isBouquetLine(line);
  const qtyEditable =
    line.lineType === PosCartLineType.PRODUCT || line.lineType === PosCartLineType.SERVICE;

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{line.nameSnapshot}</p>
          <p className="text-xs text-muted-foreground">
            {line.quantity} × {money(line.unitPrice)}
            {line.priceOverridden ? ' · цена изменена' : ''}
            {line.lineDiscountAmount !== '0.00'
              ? ` · скидка ${money(line.lineDiscountAmount)}`
              : ''}
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold">{money(line.lineSubtotal)}</p>
      </div>

      {line.childLines.length > 0 ? (
        <ul className="space-y-0.5 border-l-2 border-border pl-3 text-xs text-muted-foreground">
          {line.childLines.map((child) => (
            <li key={child.id} className="flex justify-between gap-2">
              <span className="truncate">
                {child.nameSnapshot} × {child.quantity}
              </span>
              <span className="shrink-0">{money(child.lineSubtotal)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {qtyEditable ? (
          <>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Меньше"
              disabled={busy || line.quantity <= 1}
              onClick={() => onQuantity(line.quantity - 1)}
            >
              <Minus className="size-4" />
            </Button>
            <span className="min-w-8 text-center text-sm">{line.quantity}</span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Больше"
              disabled={busy}
              onClick={() => onQuantity(line.quantity + 1)}
            >
              <Plus className="size-4" />
            </Button>
          </>
        ) : null}
        {bouquet ? (
          <Button variant="soft" size="sm" disabled={busy} onClick={onEdit}>
            Состав и цена
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-destructive"
          aria-label={`Удалить ${line.nameSnapshot}`}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}

type DialogKind = 'edit' | 'custom' | 'park' | 'list' | 'discount' | 'confirm' | 'quickSell' | null;

export function PosPage(): ReactElement {
  const { hasPermission } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();

  const canSell = hasPermission(Permission.POS_SELL);
  const canDiscount =
    hasPermission(Permission.POS_DISCOUNT) || hasPermission(Permission.ORDERS_DISCOUNT);
  const canOverridePrice =
    hasPermission(Permission.POS_PRICE_OVERRIDE) || hasPermission(Permission.ORDERS_DISCOUNT);

  const [selectedCartId, setSelectedCartId] = useState<string | null>(null);
  const [tab, setTab] = useState<CatalogTab>('ALL');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const term = useDebounced(search.trim(), 250);

  // Own OPEN + PARKED carts; OPEN ones drive the initial selection.
  const cartsQuery = useQuery({
    queryKey: queryKeys.posCarts(),
    queryFn: () => listCarts(),
  });
  // Active cart: the user's choice while it is still OPEN, otherwise the first OPEN cart.
  const openCarts = (cartsQuery.data ?? []).filter((c) => c.status === PosCartStatus.OPEN);
  const activeCartId =
    (selectedCartId && openCarts.some((c) => c.id === selectedCartId) ? selectedCartId : null) ??
    openCarts[0]?.id ??
    null;
  const cartQuery = useQuery({
    queryKey: queryKeys.posCart(activeCartId ?? ''),
    queryFn: () => getCart(activeCartId as string),
    enabled: Boolean(activeCartId),
  });
  const popularQuery = useQuery({
    queryKey: queryKeys.posCatalogPopular,
    queryFn: popularCatalog,
  });
  const searchQuery = useQuery({
    queryKey: queryKeys.posCatalogSearch(term),
    queryFn: () => searchCatalog(term),
    enabled: term.length > 0,
  });

  const cart =
    cartQuery.data && cartQuery.data.status === PosCartStatus.OPEN ? cartQuery.data : null;
  const carts = cartsQuery.data ?? [];
  const parkedCarts = carts.filter((c) => c.status === PosCartStatus.PARKED);
  const otherCarts = carts.filter(
    (c) => c.status === PosCartStatus.PARKED || c.id !== activeCartId,
  );

  const invalidateCarts = () => queryClient.invalidateQueries({ queryKey: ['pos', 'carts'] });

  const applyCart = (next: PosCartDto) => {
    queryClient.setQueryData(queryKeys.posCart(next.id), next);
    // Keep the cart list consistent immediately (status / version / totals).
    const item: PosCartListItem = {
      id: next.id,
      status: next.status,
      ownerUserId: next.ownerUserId,
      version: next.version,
      total: next.total,
      lineCount: next.lines.length,
      parkedAt: next.parkedAt,
      parkedLabel: next.parkedLabel,
      updatedAt: next.updatedAt,
    };
    queryClient.setQueryData<PosCartListItem[]>(queryKeys.posCarts(), (old) =>
      old?.some((c) => c.id === next.id)
        ? old.map((c) => (c.id === next.id ? item : c))
        : [...(old ?? []), item],
    );
    void invalidateCarts();
  };

  const onMutationError = (err: unknown, fallback: string) => {
    setError(userFacingError(err, fallback));
    if (err instanceof ApiClientError && err.body.code === 'POS_CART_CONFLICT' && activeCartId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.posCart(activeCartId) });
    }
  };

  const closeDialog = () => {
    setDialog(null);
    setEditLineId(null);
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: createCart,
    onSuccess: (created) => {
      applyCart(created);
      setSelectedCartId(created.id);
    },
    onError: (err) => onMutationError(err, 'Не удалось создать корзину'),
  });

  // No OPEN cart for this user (first visit, or after parking) — create one.
  const createCartMutate = createMutation.mutate;
  const cartsLoaded = Boolean(cartsQuery.data);
  useEffect(() => {
    if (activeCartId || !cartsLoaded || creatingRef.current) return;
    creatingRef.current = true;
    createCartMutate(undefined, {
      onSettled: () => {
        creatingRef.current = false;
      },
    });
  }, [activeCartId, cartsLoaded, createCartMutate]);

  const addMutation = useMutation({
    mutationFn: ({ cartId, input }: { cartId: string; input: AddPosLineInput }) =>
      addLine(cartId, input),
    onSuccess: (next) => {
      setError(null);
      applyCart(next);
    },
    onError: (err) => onMutationError(err, 'Не удалось добавить позицию'),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      cartId,
      lineId,
      input,
    }: {
      cartId: string;
      lineId: string;
      input: UpdatePosLineInput;
    }) => updateLine(cartId, lineId, input),
    onSuccess: (next) => {
      setError(null);
      applyCart(next);
    },
    onError: (err) => onMutationError(err, 'Не удалось обновить позицию'),
  });

  const removeMutation = useMutation({
    mutationFn: ({
      cartId,
      lineId,
      version,
    }: {
      cartId: string;
      lineId: string;
      version: number;
    }) => removeLine(cartId, lineId, version),
    onSuccess: (next) => {
      setError(null);
      applyCart(next);
    },
    onError: (err) => onMutationError(err, 'Не удалось удалить позицию'),
  });

  const discountMutation = useMutation({
    mutationFn: (input: {
      cartId: string;
      version: number;
      type: DiscountType | null;
      value: string | null;
    }) =>
      updateDiscount(input.cartId, {
        expectedVersion: input.version,
        discountType: input.type,
        discountValue: input.value,
      }),
    onSuccess: (next) => {
      applyCart(next);
      closeDialog();
    },
    onError: (err) => onMutationError(err, 'Не удалось применить скидку'),
  });

  const parkMutation = useMutation({
    mutationFn: ({ target, label }: { target: PosCartDto; label: string }) =>
      parkCart(target.id, { expectedVersion: target.version, parkedLabel: label || null }),
    onSuccess: (parked) => {
      // Marks it PARKED in the list; the active cart then falls back to another OPEN one
      // (or a fresh cart is created by the effect above).
      applyCart(parked);
      setSelectedCartId(null);
      closeDialog();
    },
    onError: (err) => onMutationError(err, 'Не удалось отложить корзину'),
  });

  const resumeMutation = useMutation({
    mutationFn: (item: PosCartListItem) => resumeCart(item.id, item.version),
    onSuccess: (resumed) => {
      applyCart(resumed);
      setSelectedCartId(resumed.id);
      closeDialog();
    },
    onError: (err) => onMutationError(err, 'Не удалось продолжить корзину'),
  });

  const confirmMutation = useMutation({
    mutationFn: ({ cartId, input }: { cartId: string; input: Parameters<typeof confirmCart>[1] }) =>
      confirmCart(cartId, input),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pos', 'carts'] }),
        queryClient.invalidateQueries({ queryKey: ['pos', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse'] }),
        queryClient.invalidateQueries({ queryKey: ['assembled-bouquets'] }),
      ]);
      router.push(`/app/orders/${result.orderId}`);
    },
    onError: (err) => onMutationError(err, 'Не удалось оформить продажу'),
  });

  const quickSellMutation = useMutation({
    mutationFn: ({
      cartId,
      input,
    }: {
      cartId: string;
      input: Parameters<typeof quickSellCart>[1];
    }) => quickSellCart(cartId, input),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pos', 'carts'] }),
        queryClient.invalidateQueries({ queryKey: ['pos', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse'] }),
        queryClient.invalidateQueries({ queryKey: ['assembled-bouquets'] }),
        queryClient.invalidateQueries({ queryKey: ['cash'] }),
      ]);
      if (result.warnings.length > 0) {
        setError(result.warnings.join(' · '));
      }
      router.push(`/app/orders/${result.orderId}`);
    },
    onError: (err) => onMutationError(err, 'Не удалось оплатить и выдать'),
  });

  const cartBusy =
    addMutation.isPending ||
    updateMutation.isPending ||
    removeMutation.isPending ||
    discountMutation.isPending;

  const addCatalogItem = (item: PosCatalogItemDto) => {
    if (!cart || cartBusy) return;
    setError(null);
    addMutation.mutate({ cartId: cart.id, input: catalogLineInput(item, cart.version) });
  };

  const createCustomBouquet = (flower: PosCatalogItemDto) => {
    if (!cart) return;
    const knownIds = new Set(cart.lines.map((l) => l.id));
    addMutation.mutate(
      {
        cartId: cart.id,
        input: {
          expectedVersion: cart.version,
          lineType: PosCartLineType.BOUQUET_CUSTOM,
          nameSnapshot: CUSTOM_BOUQUET_NAME,
          components: [{ productId: flower.id, quantity: 1 }],
        },
      },
      {
        onSuccess: (next) => {
          const created = next.lines.find((l) => !knownIds.has(l.id));
          setError(null);
          if (created) {
            setEditLineId(created.id);
            setDialog('edit');
          } else {
            setDialog(null);
          }
        },
      },
    );
  };

  // Catalog list: search results when a query is typed, otherwise popular quick-picks.
  const searching = term.length > 0;
  const sourceItems = searching ? searchQuery.data : popularQuery.data;
  const catalogLoading = searching ? searchQuery.isLoading : popularQuery.isLoading;
  const visibleItems = (sourceItems ?? []).filter((i) => tab === 'ALL' || i.kind === tab);
  const needsSearchHint = !searching && (tab === 'SERVICE' || tab === 'ASSEMBLED');

  const editLine = editLineId ? (cart?.lines.find((l) => l.id === editLineId) ?? null) : null;

  const showPageError = dialog === null;

  let cartPanel: ReactNode;
  if (!cart) {
    cartPanel = (
      <div className="p-6 text-sm text-muted-foreground">
        {createMutation.isError || cartQuery.isError ? (
          <div className="space-y-3">
            <p>Не удалось загрузить корзину.</p>
            <Button
              variant="outline"
              onClick={() => {
                if (activeCartId) void cartQuery.refetch();
                else createCartMutate();
              }}
            >
              Повторить
            </Button>
          </div>
        ) : (
          'Загрузка корзины...'
        )}
      </div>
    );
  } else {
    const hasDiscount = cart.discountType !== null && cart.discountAmount !== '0.00';
    cartPanel = (
      <>
        {cart.lines.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            Корзина пуста. Выберите позицию в каталоге.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {cart.lines.map((line) => (
              <CartLineRow
                key={line.id}
                line={line}
                busy={cartBusy}
                onRemove={() =>
                  removeMutation.mutate({ cartId: cart.id, lineId: line.id, version: cart.version })
                }
                onEdit={() => {
                  setError(null);
                  setEditLineId(line.id);
                  setDialog('edit');
                }}
                onQuantity={(quantity) =>
                  updateMutation.mutate({
                    cartId: cart.id,
                    lineId: line.id,
                    input: { expectedVersion: cart.version, quantity },
                  })
                }
              />
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t border-border px-4 py-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Сумма</span>
            <span>{money(cart.subtotal)}</span>
          </div>
          {hasDiscount ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Скидка
                {cart.discountType === DiscountType.PERCENT ? ` ${cart.discountValue}%` : ''}
              </span>
              <span>−{money(cart.discountAmount)}</span>
            </div>
          ) : null}
          <div className="flex justify-between text-base font-semibold">
            <span>Итого</span>
            <span>{money(cart.total)}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-border p-4">
          {canDiscount ? (
            <Button
              variant="outline"
              disabled={cartBusy || cart.lines.length === 0}
              onClick={() => {
                setError(null);
                setDialog('discount');
              }}
            >
              Скидка
            </Button>
          ) : null}
          <Button
            variant="outline"
            className={canDiscount ? undefined : 'col-span-2'}
            disabled={cartBusy || cart.lines.length === 0}
            onClick={() => {
              setError(null);
              setDialog('park');
            }}
          >
            Отложить
          </Button>
          <Button
            className="col-span-2"
            disabled={cartBusy || cart.lines.length === 0 || !canSell}
            title={canSell ? undefined : 'Недостаточно прав для оформления'}
            onClick={() => {
              setError(null);
              setDialog('confirm');
            }}
          >
            Оформить заказ
          </Button>
          {canSell && hasPermission(Permission.PAYMENTS_CREATE) ? (
            <Button
              className="col-span-2"
              variant="soft"
              disabled={cartBusy || cart.lines.length === 0}
              onClick={() => {
                setError(null);
                setDialog('quickSell');
              }}
            >
              Оплатить и выдать
            </Button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Продажи"
        description="Касса: соберите корзину и оформите продажу"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                setDialog('list');
              }}
            >
              Отложенные{parkedCarts.length > 0 ? ` (${parkedCarts.length})` : ''}
            </Button>
            <Button
              variant="outline"
              disabled={!cart || cartBusy}
              onClick={() => {
                setError(null);
                setDialog('custom');
              }}
            >
              {CUSTOM_BOUQUET_NAME}
            </Button>
          </>
        }
      />

      {showPageError ? <ErrorBanner message={error} /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* Catalog */}
        <section className="space-y-4 rounded-[28px] border border-border bg-card p-4 sm:p-5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="pl-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию…"
              aria-label="Поиск по каталогу"
            />
          </div>

          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Категории каталога">
            {TABS.map((t) => (
              <Button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                variant={tab === t.id ? 'default' : 'soft'}
                size="sm"
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {catalogLoading ? (
            <p className="text-sm text-muted-foreground">Загрузка каталога…</p>
          ) : needsSearchHint ? (
            <p className="text-sm text-muted-foreground">
              Введите название в поиске, чтобы найти позиции этой категории.
            </p>
          ) : visibleItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ничего не найдено</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {visibleItems.map((item) => {
                const out = item.availableQuantity !== null && item.availableQuantity <= 0;
                return (
                  <li key={`${item.kind}:${item.id}`}>
                    <button
                      type="button"
                      disabled={!cart || cartBusy}
                      onClick={() => addCatalogItem(item)}
                      className="flex min-h-11 w-full flex-col items-start gap-1 rounded-[20px] border border-border bg-card p-3 text-left transition-colors hover:bg-muted active:scale-[0.99] active:bg-muted/80 disabled:opacity-50"
                    >
                      <span className="line-clamp-2 text-sm font-medium">{item.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {KIND_LABELS_RU[item.kind]}
                        {item.assembledNumber ? ` · ${item.assembledNumber}` : ''}
                      </span>
                      <span className="mt-auto flex w-full items-center justify-between gap-2 text-xs">
                        <span className="font-semibold">
                          {item.salePrice ? money(item.salePrice) : 'Без цены'}
                        </span>
                        {item.availableQuantity !== null ? (
                          <span className={out ? 'text-destructive' : 'text-muted-foreground'}>
                            {out ? 'нет в наличии' : `${item.availableQuantity} шт.`}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Cart */}
        <aside className="h-fit overflow-hidden rounded-[28px] border border-border bg-card lg:sticky lg:top-6">
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">Корзина</h2>
            {cart ? (
              <span className="text-xs text-muted-foreground">Позиций: {cart.lines.length}</span>
            ) : null}
          </header>
          {cartPanel}
        </aside>
      </div>

      {dialog === 'edit' && editLine && cart ? (
        <BouquetEditorDialog
          key={editLine.id}
          line={editLine}
          canOverridePrice={canOverridePrice}
          busy={updateMutation.isPending}
          error={error}
          onClose={closeDialog}
          onSave={(patch) =>
            updateMutation.mutate(
              {
                cartId: cart.id,
                lineId: editLine.id,
                input: { expectedVersion: cart.version, ...patch },
              },
              { onSuccess: closeDialog },
            )
          }
        />
      ) : null}

      {dialog === 'custom' ? (
        <CustomBouquetDialog
          busy={addMutation.isPending}
          error={error}
          onClose={closeDialog}
          onCreate={createCustomBouquet}
        />
      ) : null}

      {dialog === 'park' && cart ? (
        <ParkDialog
          busy={parkMutation.isPending}
          error={error}
          onClose={closeDialog}
          onPark={(label) => parkMutation.mutate({ target: cart, label })}
        />
      ) : null}

      {dialog === 'list' ? (
        <CartListDialog
          carts={otherCarts}
          activeId={activeCartId}
          busy={resumeMutation.isPending}
          error={error}
          onClose={closeDialog}
          onResume={(item) => resumeMutation.mutate(item)}
          onSwitch={(id) => {
            setSelectedCartId(id);
            closeDialog();
          }}
        />
      ) : null}

      {dialog === 'discount' && cart ? (
        <DiscountDialog
          cart={cart}
          busy={discountMutation.isPending}
          error={error}
          onClose={closeDialog}
          onApply={(type, value) =>
            discountMutation.mutate({ cartId: cart.id, version: cart.version, type, value })
          }
        />
      ) : null}

      {dialog === 'confirm' && cart ? (
        <PosConfirmDialog
          cart={cart}
          busy={confirmMutation.isPending}
          error={error}
          onClose={closeDialog}
          onConfirm={(input) => confirmMutation.mutate({ cartId: cart.id, input })}
        />
      ) : null}

      {dialog === 'quickSell' && cart ? (
        <PosQuickSellDialog
          cart={cart}
          busy={quickSellMutation.isPending}
          error={error}
          onClose={closeDialog}
          onSubmit={(input) => quickSellMutation.mutate({ cartId: cart.id, input })}
        />
      ) : null}
    </div>
  );
}

function PosQuickSellDialog({
  cart,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  cart: PosCartDto;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: Parameters<typeof quickSellCart>[1]) => void;
}): ReactElement {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [method, setMethod] = useState<'CASH' | 'CARD_TERMINAL'>('CASH');
  const [issue, setIssue] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const shiftQuery = useQuery({
    queryKey: ['cash', 'current'],
    queryFn: () => getCurrentCashShift(),
  });

  const submit = async () => {
    setLocalError(null);
    if (method === 'CASH' && !shiftQuery.data?.shift) {
      setLocalError('Откройте кассовую смену для приёма наличных');
      return;
    }
    onSubmit({
      expectedVersion: cart.version,
      idempotencyKey,
      issue,
      payments: [
        {
          method,
          amount: cart.total,
          idempotencyKey: `${idempotencyKey}-pay1`,
        },
      ],
    });
  };

  const openShift = async () => {
    setOpening(true);
    setLocalError(null);
    try {
      await openCashShift({ openingFloat: '0.00' });
      await shiftQuery.refetch();
    } catch (err) {
      setLocalError(userFacingError(err, 'Не удалось открыть смену'));
    } finally {
      setOpening(false);
    }
  };

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      size="md"
      title="Оплатить и выдать"
      description={`Сумма: ${money(cart.total)} · быстрая продажа в магазине`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy || opening}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || opening}>
            {busy ? 'Проведение…' : 'Принять оплату'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={localError ?? error} />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Способ оплаты</legend>
          {(
            [
              [PaymentMethod.CASH, 'Наличные'],
              [PaymentMethod.CARD_TERMINAL, 'Карта (терминал)'],
            ] as const
          ).map(([m, label]) => (
            <label
              key={m}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border px-4 py-2 text-sm',
                method === m ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="pos-pay-method"
                checked={method === m}
                onChange={() => setMethod(m)}
                className="size-4"
              />
              {label}
            </label>
          ))}
        </fieldset>
        {method === 'CASH' ? (
          <div className="rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm">
            {shiftQuery.data?.shift ? (
              <p>
                Смена открыта · {shiftQuery.data.shift.cashRegisterName} · начало{' '}
                {shiftQuery.data.shift.openingFloat} BYN
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground">Нет открытой кассовой смены</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={opening}
                  onClick={() => void openShift()}
                >
                  {opening ? 'Открытие…' : 'Открыть смену'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Запись о платеже терминалом вносится вручную (не автопроверка у банка).
          </p>
        )}
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={issue}
            onChange={(e) => setIssue(e.target.checked)}
          />
          Сразу выдать товар со склада
        </label>
      </div>
    </ResponsiveDialog>
  );
}
