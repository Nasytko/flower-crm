'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProductType, type SupplyDetail } from '@erp/shared';
import { listProducts } from '@/lib/api/products';
import { createSupply, postSupply, updateSupply } from '@/lib/api/supplies';
import { getActiveInventory } from '@/lib/api/inventories';
import { queryKeys } from '@/lib/query-keys';
import { invalidateStockViews } from '@/lib/query-invalidation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { ProductPicker } from '@/components/ui/product-picker';
import { StickyActionBar } from '@/components/ui/sticky-action-bar';
import { ApiClientError } from '@/lib/api/client';
import { userFacingError } from '@/lib/api/error-messages';
import Link from 'next/link';

interface LineDraft {
  key: string;
  productId: string;
  quantity: string;
  unitPurchasePrice: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function moneyMul(price: string, qty: number): string {
  const p = Number.parseFloat(price.replace(',', '.'));
  if (!Number.isFinite(p) || !Number.isFinite(qty)) return '—';
  return (p * qty).toFixed(2);
}

export function SupplyEditor({
  mode,
  initial,
  title,
}: {
  mode: 'create' | 'edit';
  initial?: SupplyDetail;
  title: string;
}): ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [documentDate, setDocumentDate] = useState(initial?.documentDate ?? todayIso());
  const [supplierName, setSupplierName] = useState(initial?.supplierName ?? '');
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    initial?.items.map((item, index) => ({
      key: `${item.id}-${index}`,
      productId: item.productId,
      quantity: String(item.quantity),
      unitPurchasePrice: item.unitPurchasePrice ?? '',
    })) ?? [{ key: '1', productId: '', quantity: '1', unitPurchasePrice: '' }],
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);

  const flowersQuery = useQuery({
    queryKey: queryKeys.products({ type: ProductType.FLOWER, isActive: 'true', limit: 100 }),
    queryFn: () => listProducts({ type: ProductType.FLOWER, isActive: 'true', limit: 100 }),
  });

  const activeInventoryQuery = useQuery({
    queryKey: queryKeys.activeInventory,
    queryFn: getActiveInventory,
  });
  const stockFrozen = Boolean(activeInventoryQuery.data);

  const flowers = flowersQuery.data?.items ?? [];
  const selectedProductIds = useMemo(
    () => lines.map((line) => line.productId).filter(Boolean),
    [lines],
  );

  const totals = useMemo(() => {
    let qty = 0;
    let amount = 0;
    for (const line of lines) {
      const q = Number.parseInt(line.quantity, 10);
      const p = Number.parseFloat(line.unitPurchasePrice.replace(',', '.'));
      if (Number.isInteger(q) && q > 0) qty += q;
      if (Number.isInteger(q) && q > 0 && Number.isFinite(p)) amount += q * p;
    }
    return { qty, amount: amount.toFixed(2), count: lines.filter((l) => l.productId).length };
  }, [lines]);

  const saveMutation = useMutation({
    mutationFn: async (andPost: boolean) => {
      const items = lines
        .filter((l) => l.productId)
        .map((l) => ({
          productId: l.productId,
          quantity: Number.parseInt(l.quantity, 10),
          unitPurchasePrice: l.unitPurchasePrice.trim().replace(',', '.'),
        }));
      if (items.length === 0) {
        throw new ApiClientError(400, {
          code: 'SUPPLY_EMPTY',
          message: 'Добавьте хотя бы одну позицию',
          details: {},
        });
      }
      for (const item of items) {
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
          throw new ApiClientError(400, {
            code: 'VALIDATION_ERROR',
            message: 'Количество должно быть положительным целым',
            details: {},
          });
        }
      }

      let supply: SupplyDetail;
      if (mode === 'create') {
        supply = await createSupply({
          documentDate,
          supplierName: supplierName.trim() || null,
          comment: comment.trim() || null,
          items,
        });
      } else {
        supply = await updateSupply(initial!.id, {
          documentDate,
          supplierName: supplierName.trim() || null,
          comment: comment.trim() || null,
          items,
        });
      }

      if (andPost) {
        supply = await postSupply(supply.id);
      }
      return supply;
    },
    onSuccess: async (supply, andPost) => {
      await queryClient.invalidateQueries({ queryKey: ['supplies'] });
      if (andPost) {
        await invalidateStockViews(queryClient);
      } else {
        await queryClient.invalidateQueries({ queryKey: ['products'] });
      }
      router.push(`/app/supplies/${supply.id}`);
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка сохранения'));
      setConfirmPost(false);
    },
  });

  const activeInventory = activeInventoryQuery.data ?? null;

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const removeLine = (key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  };

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        key: String(Date.now()),
        productId: '',
        quantity: '1',
        unitPurchasePrice: '',
      },
    ]);
  };

  const actionButtons = (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full sm:w-auto"
        onClick={() => router.push('/app/supplies')}
      >
        Отмена
      </Button>
      <Button
        type="button"
        variant="soft"
        className="min-h-11 w-full sm:w-auto"
        disabled={saveMutation.isPending}
        onClick={() => {
          setError(null);
          saveMutation.mutate(false);
        }}
      >
        Сохранить черновик
      </Button>
      <Button
        type="button"
        className="min-h-11 w-full sm:w-auto"
        disabled={saveMutation.isPending || stockFrozen}
        title={stockFrozen ? 'Недоступно во время инвентаризации' : undefined}
        onClick={() => {
          if (stockFrozen) {
            setError('Недоступно во время инвентаризации');
            return;
          }
          if (!confirmPost) {
            setConfirmPost(true);
            setError('Подтвердите проведение ещё раз');
            return;
          }
          setError(null);
          saveMutation.mutate(true);
        }}
      >
        {confirmPost ? 'Подтвердить проведение' : 'Провести поставку'}
      </Button>
    </>
  );

  return (
    <div className="min-w-0 space-y-6 pb-28 sm:pb-0">
      <PageHeader
        title={title}
        description={
          initial?.correctionOfNumber != null ? (
            <p className="mt-1 rounded-2xl bg-warn-soft px-4 py-2 text-sm text-warn-fg">
              Коррекция поставки П-{String(initial.correctionOfNumber).padStart(6, '0')}. Исходная
              поставка будет отменена при проведении коррекции.
            </p>
          ) : undefined
        }
      />

      {activeInventory ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-border bg-primary-soft/60 px-5 py-3 text-sm">
          <p>
            Идёт инвентаризация {activeInventory.numberLabel}. Проведение поставок временно
            недоступно.
          </p>
          <Link
            href={`/app/inventories/${activeInventory.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            Открыть инвентаризацию
          </Link>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger-fg">{error}</p> : null}

      <section className="grid grid-cols-1 gap-4 rounded-[28px] border border-border bg-card p-4 sm:p-6 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="supply-date">Дата поставки</Label>
          <Input
            id="supply-date"
            type="date"
            value={documentDate}
            onChange={(e) => setDocumentDate(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="supply-supplier">Поставщик</Label>
          <Input
            id="supply-supplier"
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
            placeholder="Необязательно"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="supply-comment">Комментарий</Label>
          <Input id="supply-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-4 sm:px-6">
          <h2 className="font-semibold">Позиции</h2>
          <Button
            type="button"
            variant="soft"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={addLine}
          >
            + Добавить позицию
          </Button>
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <th className="px-5 py-3 font-medium">Товар</th>
                <th className="px-3 py-3 font-medium">Кол-во</th>
                <th className="px-3 py-3 font-medium">Закупочная</th>
                <th className="px-3 py-3 font-medium">Сумма</th>
                <th className="px-5 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-border/80">
                  <td className="px-5 py-3">
                    <ProductPicker
                      products={flowers}
                      value={line.productId}
                      placeholder="Выберите цветок…"
                      reservedIds={selectedProductIds}
                      reservedLabel="уже в поставке"
                      showStock
                      ariaLabel="Товар поставки"
                      onChange={(productId) => updateLine(line.key, { productId })}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      inputMode="numeric"
                      value={line.quantity}
                      onChange={(e) =>
                        updateLine(line.key, { quantity: e.target.value.replace(/[^\d]/g, '') })
                      }
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      inputMode="decimal"
                      placeholder="5.20"
                      value={line.unitPurchasePrice}
                      onChange={(e) => updateLine(line.key, { unitPurchasePrice: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-3 tabular-nums">
                    {moneyMul(line.unitPurchasePrice, Number.parseInt(line.quantity, 10))} BYN
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={lines.length <= 1}
                      onClick={() => removeLine(line.key)}
                    >
                      Удалить
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-3 p-3 md:hidden">
          {lines.map((line, index) => (
            <div key={line.key} className="space-y-3 rounded-2xl border border-border/80 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Позиция {index + 1}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11"
                  disabled={lines.length <= 1}
                  onClick={() => removeLine(line.key)}
                >
                  Удалить
                </Button>
              </div>
              <div className="space-y-2">
                <Label>Товар</Label>
                <ProductPicker
                  products={flowers}
                  value={line.productId}
                  placeholder="Выберите цветок…"
                  reservedIds={selectedProductIds}
                  reservedLabel="уже в поставке"
                  showStock
                  ariaLabel="Товар поставки"
                  onChange={(productId) => updateLine(line.key, { productId })}
                />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-2">
                  <Label>Кол-во</Label>
                  <Input
                    inputMode="numeric"
                    value={line.quantity}
                    onChange={(e) =>
                      updateLine(line.key, { quantity: e.target.value.replace(/[^\d]/g, '') })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Закупочная</Label>
                  <Input
                    inputMode="decimal"
                    placeholder="5.20"
                    value={line.unitPurchasePrice}
                    onChange={(e) => updateLine(line.key, { unitPurchasePrice: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-sm tabular-nums text-muted-foreground">
                Сумма:{' '}
                <span className="font-medium text-foreground">
                  {moneyMul(line.unitPurchasePrice, Number.parseInt(line.quantity, 10))} BYN
                </span>
              </p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 border-t border-border px-4 py-4 text-sm sm:gap-6 sm:px-6">
          <span>Позиций: {totals.count}</span>
          <span>Единиц: {totals.qty}</span>
          <span className="font-medium">Сумма: {totals.amount} BYN</span>
        </div>
      </section>

      <div className="hidden flex-wrap gap-3 sm:flex">{actionButtons}</div>
      <StickyActionBar className="sm:hidden">{actionButtons}</StickyActionBar>
    </div>
  );
}
