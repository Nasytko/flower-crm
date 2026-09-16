'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission, ProductType, type BouquetDetail, type ProductListItem } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { listProducts } from '@/lib/api/products';
import { createBouquet, updateBouquet } from '@/lib/api/bouquets';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { ProductPicker } from '@/components/ui/product-picker';
import { StickyActionBar } from '@/components/ui/sticky-action-bar';
import { userFacingError } from '@/lib/api/error-messages';

interface LineDraft {
  key: string;
  productId: string;
  quantity: string;
}

function moneyMul(unit: string | null | undefined, qty: number): number | null {
  if (unit == null) return null;
  const p = Number.parseFloat(unit);
  if (!Number.isFinite(p) || !Number.isFinite(qty)) return null;
  return p * qty;
}

export function BouquetEditor({
  mode,
  initial,
}: {
  mode: 'create' | 'edit';
  initial?: BouquetDetail;
}): ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canViewCost = hasPermission(Permission.PURCHASE_PRICE_VIEW);
  const canManage = hasPermission(Permission.BOUQUETS_MANAGE);

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [salePrice, setSalePrice] = useState(initial?.salePrice ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    initial?.items.map((item, index) => ({
      key: `${item.id}-${index}`,
      productId: item.productId,
      quantity: String(item.quantity),
    })) ?? [{ key: '1', productId: '', quantity: '1' }],
  );
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: queryKeys.products({ isActive: 'true', limit: 100 }),
    queryFn: () => listProducts({ isActive: 'true', limit: 100 }),
  });

  const products = useMemo(() => productsQuery.data?.items ?? [], [productsQuery.data?.items]);
  const productById = useMemo(() => {
    const map = new Map<string, ProductListItem>();
    for (const p of products) map.set(p.id, p);
    // Keep inactive / missing components from initial for display
    if (initial) {
      for (const item of initial.items) {
        if (!map.has(item.productId)) {
          map.set(item.productId, {
            id: item.productId,
            name: item.productName,
            sku: item.productSku,
            type: item.productType,
            description: null,
            unit: item.unit,
            salePrice: null,
            isActive: item.isActive,
            stock:
              item.availableStock != null
                ? {
                    quantityOnHand: item.availableStock,
                    quantityReserved: 0,
                    availableQuantity: item.availableStock,
                  }
                : null,
            createdAt: '',
            updatedAt: '',
            ...(canViewCost && item.currentComponentCost != null
              ? item.productType === ProductType.FLOWER
                ? {
                    averagePurchaseCost: item.currentComponentCost,
                    hasUncostedStock: false,
                  }
                : { purchasePrice: item.currentComponentCost }
              : {}),
          });
        }
      }
    }
    return map;
  }, [products, initial, canViewCost]);

  const flowers = useMemo(
    () =>
      [...productById.values()]
        .filter((p) => p.type === ProductType.FLOWER)
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [productById],
  );
  const services = useMemo(
    () =>
      [...productById.values()]
        .filter((p) => p.type === ProductType.SERVICE)
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [productById],
  );
  const pickerProducts = useMemo(() => [...flowers, ...services], [flowers, services]);

  const selectedIds = useMemo(() => lines.map((l) => l.productId).filter(Boolean), [lines]);

  const preview = useMemo(() => {
    let available = Number.POSITIVE_INFINITY;
    let hasFlower = false;
    let hasInactive = false;
    let costKnown = true;
    let costTotal = 0;

    for (const line of lines) {
      if (!line.productId) continue;
      const product = productById.get(line.productId);
      if (!product) continue;
      const qty = Number.parseInt(line.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) continue;

      if (!product.isActive) hasInactive = true;
      if (product.type === ProductType.FLOWER) {
        hasFlower = true;
        const avail = product.stock?.availableQuantity ?? 0;
        available = Math.min(available, Math.floor(avail / qty));
        if (canViewCost) {
          if (product.hasUncostedStock || product.averagePurchaseCost == null) {
            costKnown = false;
          } else {
            const lineCost = moneyMul(product.averagePurchaseCost, qty);
            if (lineCost == null) costKnown = false;
            else costTotal += lineCost;
          }
        }
      } else if (canViewCost) {
        if (product.purchasePrice == null) costKnown = false;
        else {
          const lineCost = moneyMul(product.purchasePrice, qty);
          if (lineCost == null) costKnown = false;
          else costTotal += lineCost;
        }
      }
    }

    if (!hasFlower || hasInactive) available = 0;
    if (!Number.isFinite(available)) available = 0;

    const sale = Number.parseFloat(salePrice.replace(',', '.'));
    const margin = canViewCost && costKnown && Number.isFinite(sale) ? sale - costTotal : null;

    return {
      available,
      hasInactive,
      costKnown: canViewCost ? costKnown : null,
      costTotal: canViewCost && costKnown ? costTotal.toFixed(2) : null,
      margin: margin != null ? margin.toFixed(2) : null,
      marginPct: margin != null && sale > 0 ? ((margin / sale) * 100).toFixed(2) : null,
    };
  }, [lines, productById, salePrice, canViewCost]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const items = lines
        .filter((l) => l.productId)
        .map((l) => ({
          productId: l.productId,
          quantity: Number.parseInt(l.quantity, 10),
        }));
      if (mode === 'create') {
        return createBouquet({
          name: name.trim(),
          description: description.trim() || null,
          salePrice: salePrice.trim().replace(',', '.'),
          items,
        });
      }
      return updateBouquet(initial!.id, {
        expectedVersion: version,
        name: name.trim(),
        description: description.trim() || null,
        salePrice: salePrice.trim().replace(',', '.'),
        items,
      });
    },
    onSuccess: async (detail) => {
      setMessage(mode === 'create' ? 'Букет создан' : 'Букет сохранён');
      setError(null);
      setVersion(detail.version);
      await queryClient.invalidateQueries({ queryKey: ['bouquets'] });
      router.push(`/app/bouquets/${detail.id}`);
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка сохранения'));
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (isActive: boolean) =>
      updateBouquet(initial!.id, { expectedVersion: version, isActive }),
    onSuccess: async (detail) => {
      setVersion(detail.version);
      setIsActive(detail.isActive);
      setMessage(detail.isActive ? 'Букет активирован' : 'Букет деактивирован');
      await queryClient.invalidateQueries({ queryKey: ['bouquets'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.bouquet(detail.id) });
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка'));
    },
  });

  if (!canManage && mode === 'create') {
    return <p className="text-sm text-muted-foreground">Недостаточно прав</p>;
  }

  const productsLoadError = productsQuery.isError
    ? userFacingError(productsQuery.error, 'Не удалось загрузить товары')
    : null;
  const productsTruncated =
    (productsQuery.data?.total ?? 0) > (productsQuery.data?.items.length ?? 0);

  return (
    <div className={canManage ? 'space-y-6 pb-24 sm:pb-0' : 'space-y-6'}>
      <PageHeader
        title={mode === 'create' ? 'Новый букет' : (initial?.name ?? 'Букет')}
        description={
          <div className="space-y-1">
            <button
              type="button"
              className="text-sm text-muted-foreground hover:underline"
              onClick={() => router.push('/app/bouquets')}
            >
              ← К списку
            </button>
            {mode === 'edit' && initial ? (
              <p>
                Версия {version}
                {!isActive ? ' · неактивен' : ''}
              </p>
            ) : null}
          </div>
        }
        actions={
          mode === 'edit' && canManage && initial ? (
            <Button
              type="button"
              variant="outline"
              className="hidden sm:inline-flex"
              disabled={toggleActiveMutation.isPending}
              onClick={() => toggleActiveMutation.mutate(!isActive)}
            >
              {isActive ? 'Деактивировать' : 'Активировать'}
            </Button>
          ) : null
        }
      />

      {message ? (
        <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      {productsLoadError ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">
          Справочник товаров: {productsLoadError}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => void productsQuery.refetch()}
          >
            Повторить
          </button>
        </p>
      ) : null}
      {productsTruncated ? (
        <p className="rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm">
          Показаны первые {productsQuery.data?.items.length} активных товаров из{' '}
          {productsQuery.data?.total}. Если нужного нет в списке — уточните каталог или
          деактивируйте лишние.
        </p>
      ) : null}
      {productsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка товаров для состава...</p>
      ) : null}

      {preview.hasInactive ? (
        <p className="rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm">
          В составе есть неактивные позиции.
        </p>
      ) : null}

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-4 sm:p-6">
        <h2 className="text-base font-semibold">Основное</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="bq-name">Название *</Label>
            <Input
              id="bq-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              disabled={!canManage}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="bq-desc">Описание</Label>
            <Input
              id="bq-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              disabled={!canManage}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bq-price">Цена продажи, BYN *</Label>
            <Input
              id="bq-price"
              value={salePrice}
              onChange={(e) => setSalePrice(e.target.value)}
              inputMode="decimal"
              disabled={!canManage}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Состав букета</h2>
          {canManage ? (
            <Button
              type="button"
              variant="soft"
              size="sm"
              onClick={() =>
                setLines((prev) => [
                  ...prev,
                  { key: String(Date.now()), productId: '', quantity: '1' },
                ])
              }
            >
              + Добавить позицию
            </Button>
          ) : null}
        </div>

        <div className="space-y-3">
          {lines.map((line, index) => {
            const product = line.productId ? productById.get(line.productId) : undefined;
            return (
              <div
                key={line.key}
                className="flex flex-col gap-3 rounded-2xl border border-border/80 bg-muted/20 p-3 sm:grid sm:grid-cols-[minmax(0,1fr)_100px_auto] sm:items-end sm:gap-2"
              >
                <div className="min-w-0 space-y-1.5">
                  <Label className="sm:sr-only">Товар</Label>
                  <ProductPicker
                    products={pickerProducts}
                    value={line.productId}
                    disabled={!canManage}
                    placeholder="Выберите товар…"
                    reservedIds={selectedIds}
                    reservedLabel="уже в букете"
                    ariaLabel={`Товар в составе, строка ${index + 1}`}
                    onChange={(productId) => {
                      setLines((prev) =>
                        prev.map((l, i) => (i === index ? { ...l, productId } : l)),
                      );
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="sm:sr-only" htmlFor={`bq-qty-${line.key}`}>
                    Количество
                  </Label>
                  <Input
                    id={`bq-qty-${line.key}`}
                    className="min-h-11 sm:min-h-0"
                    inputMode="numeric"
                    value={line.quantity}
                    disabled={!canManage}
                    aria-label="Количество"
                    onChange={(e) => {
                      const quantity = e.target.value.replace(/[^\d]/g, '');
                      setLines((prev) =>
                        prev.map((l, i) => (i === index ? { ...l, quantity } : l)),
                      );
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground sm:justify-start">
                  {product?.type === ProductType.FLOWER ? (
                    <span>На складе: {product.stock?.availableQuantity ?? 0}</span>
                  ) : (
                    <span className="sm:hidden" />
                  )}
                  {canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-10 sm:min-h-0"
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                    >
                      Удалить
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-[28px] border border-border bg-card px-6 py-4 text-sm">
        <div className="font-medium">Предпросмотр</div>
        <div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
          <div>
            Можно собрать:{' '}
            <span className="text-foreground">
              {preview.available > 0 ? preview.available : 'нет полного состава'}
            </span>
          </div>
          <div>
            Цена продажи:{' '}
            <span className="text-foreground">{salePrice ? `${salePrice} BYN` : '—'}</span>
          </div>
          {canViewCost ? (
            <>
              <div title="Расчёт по текущей стоимости складского остатка. Фактическая себестоимость заказа может отличаться. Если есть остаток без закупочной цены — себестоимость неизвестна.">
                Расчётная себестоимость:{' '}
                <span className="text-foreground">
                  {preview.costKnown
                    ? `${preview.costTotal} BYN`
                    : lines.some((l) => l.productId)
                      ? 'неизвестна'
                      : '—'}
                </span>
              </div>
              <div>
                Маржа:{' '}
                <span className="text-foreground">
                  {preview.margin != null
                    ? `${preview.margin} BYN${preview.marginPct ? ` (${preview.marginPct}%)` : ''}`
                    : '—'}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </section>

      {canManage ? (
        <>
          <div className="hidden flex-wrap gap-3 sm:flex">
            <Button type="button" variant="outline" onClick={() => router.push('/app/bouquets')}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={saveMutation.isPending}
              onClick={() => {
                setError(null);
                saveMutation.mutate();
              }}
            >
              Сохранить
            </Button>
          </div>
          <StickyActionBar className="sm:hidden">
            {mode === 'edit' && initial ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                disabled={toggleActiveMutation.isPending}
                onClick={() => toggleActiveMutation.mutate(!isActive)}
              >
                {isActive ? 'Деактивировать' : 'Активировать'}
              </Button>
            ) : null}
            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={saveMutation.isPending}
              onClick={() => {
                setError(null);
                saveMutation.mutate();
              }}
            >
              Сохранить
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
              onClick={() => router.push('/app/bouquets')}
            >
              Отмена
            </Button>
          </StickyActionBar>
        </>
      ) : null}
    </div>
  );
}
