'use client';

import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UNKNOWN_LOT_SHELF_DAYS, effectiveUsableUntilIso, Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { getWarehouseStockDetail } from '@/lib/api/warehouse';
import { queryKeys } from '@/lib/query-keys';
import { AssembledBouquetPanel } from '@/components/assembled-bouquet-panel';
import { Button } from '@/components/ui/button';
import { StatRow } from '@/components/ui/stat-row';
import { cn } from '@/lib/utils';

function formatRuDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function WarehouseStockDetailSheet({
  productId,
  onClose,
}: {
  productId: string;
  onClose: () => void;
}): ReactElement {
  const { hasPermission } = useAuth();
  const canAssemble = hasPermission(Permission.ORDERS_ASSEMBLE);
  const [bouquetId, setBouquetId] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: queryKeys.warehouseStockDetail(productId),
    queryFn: () => getWarehouseStockDetail(productId),
  });

  const detail = detailQuery.data;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-[28px] border border-border bg-card p-5 shadow-xl sm:rounded-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{detail?.productName ?? 'Остатки'}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Расшифровка: доступно, резерв, букеты, партии
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Закрыть
          </Button>
        </header>

        {detailQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : detailQuery.isError || !detail ? (
          <p className="text-sm text-danger-fg">Не удалось загрузить расшифровку</p>
        ) : (
          <div className="space-y-5">
            <section className="grid gap-1 rounded-2xl border border-border bg-muted/30 px-4 py-3 sm:grid-cols-2">
              <StatRow label="Доступно" value={detail.availableQuantity} />
              <StatRow label="Плановый резерв" value={detail.reservedQuantity} />
              <StatRow label="В готовых букетах" value={detail.quantityInBouquets} />
              <StatRow label="Всего физически" value={detail.totalPhysical} />
              <StatRow
                label="Дефицит"
                value={detail.deficitQuantity}
                emphasize={detail.deficitQuantity > 0}
                className={detail.deficitQuantity > 0 ? 'text-warn-fg' : undefined}
              />
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Плановый резерв по заказам</h3>
              {detail.reserves.length === 0 ? (
                <p className="text-sm text-muted-foreground">Нет активных резервов</p>
              ) : (
                <ul className="space-y-2">
                  {detail.reserves.map((r) => (
                    <li
                      key={r.orderId}
                      className={cn(
                        'rounded-xl border border-border/80 px-3 py-2 text-sm',
                        r.shortageQuantity > 0 && 'border-warn-fg/40 bg-warn-soft/40',
                      )}
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium">Заказ {r.orderNumber}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatRuDate(r.fulfillmentDate)}
                          {r.fulfillmentTimeFrom ? ` · ${r.fulfillmentTimeFrom}` : ''}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        нужно {r.requiredQuantity} · резерв {r.reservedQuantity}
                        {r.shortageQuantity > 0 ? ` · нехватка ${r.shortageQuantity}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Готовые букеты с этим цветком</h3>
              {detail.bouquets.length === 0 ? (
                <p className="text-sm text-muted-foreground">Нет собранных букетов</p>
              ) : (
                <ul className="space-y-2">
                  {detail.bouquets.map((b) => (
                    <li
                      key={b.assembledBouquetId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 px-3 py-2 text-sm"
                    >
                      <div>
                        <p className="font-medium">
                          {b.number} · {b.quantity} шт.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {b.orderNumber ? `Заказ ${b.orderNumber}` : 'Витрина'} ·{' '}
                          {formatRuDate(b.assembledAt.slice(0, 10))}
                        </p>
                      </div>
                      {canAssemble ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setBouquetId(b.assembledBouquetId)}
                        >
                          Открыть
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Партии на полке</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Если срок не указан, для резервов используется оценка: дата поступления +{' '}
                {UNKNOWN_LOT_SHELF_DAYS} дн.
              </p>
              {detail.freeLots.length === 0 ? (
                <p className="text-sm text-muted-foreground">Нет свободных партий</p>
              ) : (
                <ul className="space-y-2">
                  {detail.freeLots.map((lot) => {
                    const receivedIso = lot.receivedAt.slice(0, 10);
                    const effective = effectiveUsableUntilIso(lot.usableUntil, receivedIso);
                    const unknown = !lot.usableUntil;
                    return (
                      <li
                        key={lot.stockLotId}
                        className="rounded-xl border border-border/80 px-3 py-2 text-sm"
                      >
                        <div className="flex flex-wrap justify-between gap-2">
                          <span className="font-medium tabular-nums">
                            {lot.remainingQuantity} шт.
                          </span>
                          <span className="text-xs text-muted-foreground">
                            поступление {formatRuDate(receivedIso)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {unknown
                            ? `Годен до: не указан (оценка ${formatRuDate(effective)})`
                            : `Годен до: ${formatRuDate(lot.usableUntil)}`}
                          {lot.unitPurchasePrice != null ? ` · ${lot.unitPurchasePrice} BYN` : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {bouquetId ? (
              <AssembledBouquetPanel
                bouquetId={bouquetId}
                onClose={() => setBouquetId(null)}
                onChanged={() => {
                  void detailQuery.refetch();
                }}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
