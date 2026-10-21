'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  OrderItemType,
  OrderStatus,
  Permission,
  ProductType,
  type AssembledBouquetListItem,
  type OrderDetail,
  type OrderItemDto,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { getOrder } from '@/lib/api/orders';
import { assembleBouquet, directIssueOrderItem } from '@/lib/api/warehouse';
import { userFacingError } from '@/lib/api/error-messages';
import { ApiClientError } from '@/lib/api/client';
import { invalidateAfterBouquetStockMutation } from '@/lib/query-invalidation';
import { AssembledBouquetPanel, AssembledBouquetStatusBadge } from '@/components/assembled-bouquet-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatRow } from '@/components/ui/stat-row';
import { cn } from '@/lib/utils';

function plannedComponents(item: OrderItemDto): Array<{ productId: string; name: string; quantity: number }> {
  if (item.itemType === OrderItemType.BOUQUET) {
    return item.components
      .filter((c) => c.productTypeSnapshot === ProductType.FLOWER)
      .map((c) => ({
        productId: c.productId,
        name: c.productNameSnapshot,
        quantity: c.quantityPerItem,
      }));
  }
  if (item.itemType === OrderItemType.PRODUCT && item.productId) {
    return [{ productId: item.productId, name: item.nameSnapshot, quantity: 1 }];
  }
  return [];
}

function itemNeedsAssembly(item: OrderItemDto): boolean {
  if (item.itemType === OrderItemType.BOUQUET) return true;
  if (item.itemType === OrderItemType.PRODUCT) {
    // Flower product lines can be assembled as mono or direct-issued.
    return item.components.length === 0;
  }
  return false;
}

export function OrderAssemblySection({
  order,
  onOrderUpdated,
}: {
  order: OrderDetail;
  onOrderUpdated: (order: OrderDetail) => void;
}): ReactElement | null {
  const { hasPermission } = useAuth();
  const canAssemble = hasPermission(Permission.ORDERS_ASSEMBLE);
  const canIssue = hasPermission(Permission.ORDERS_ISSUE);
  const canOverride = hasPermission(Permission.ORDERS_RESERVE_OVERRIDE);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assemblingItemId, setAssemblingItemId] = useState<string | null>(null);
  const [selectedBouquetId, setSelectedBouquetId] = useState<string | null>(null);
  const [allowOverride, setAllowOverride] = useState(false);
  const [pendingOverride, setPendingOverride] = useState(false);

  const terminal =
    order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED;

  const assembledByItem = useMemo(() => {
    const map = new Map<string, AssembledBouquetListItem[]>();
    for (const b of order.assembledBouquets ?? []) {
      if (!b.orderItemId) continue;
      const list = map.get(b.orderItemId) ?? [];
      list.push(b);
      map.set(b.orderItemId, list);
    }
    return map;
  }, [order.assembledBouquets]);

  const reqByProduct = useMemo(() => {
    const m = new Map(order.requirements.map((r) => [r.productId, r]));
    return m;
  }, [order.requirements]);

  const [draftQty, setDraftQty] = useState<Record<string, string>>({});

  const openAssemble = (item: OrderItemDto) => {
    const planned = plannedComponents(item);
    const next: Record<string, string> = {};
    for (const c of planned) next[c.productId] = String(c.quantity);
    setDraftQty(next);
    setAssemblingItemId(item.id);
    setAllowOverride(false);
    setPendingOverride(false);
    setError(null);
  };

  const refreshOrder = async () => {
    const fresh = await getOrder(order.id);
    onOrderUpdated(fresh);
  };

  const assembleMut = useMutation({
    mutationFn: async (item: OrderItemDto) => {
      const planned = plannedComponents(item);
      const components = planned.map((c) => ({
        productId: c.productId,
        quantity: Math.max(1, Number.parseInt(draftQty[c.productId] ?? String(c.quantity), 10) || c.quantity),
      }));
      const idempotencyKey = `order-${order.id}-item-${item.id}-n${item.quantityAssembled}-${order.version}`;
      return assembleBouquet({
        orderId: order.id,
        orderItemId: item.id,
        bouquetTemplateId: item.bouquetId ?? undefined,
        nameSnapshot: item.nameSnapshot,
        components,
        expectedOrderVersion: order.version,
        allowReserveOverride: allowOverride && canOverride,
        idempotencyKey,
      });
    },
    onSuccess: async () => {
      setMessage('Букет собран');
      setError(null);
      setAssemblingItemId(null);
      setPendingOverride(false);
      await invalidateAfterBouquetStockMutation(queryClient);
      await refreshOrder();
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.body.code === 'RESERVE_OVERRIDE_REQUIRED') {
        setPendingOverride(true);
        setError(userFacingError(err));
        return;
      }
      setError(userFacingError(err, 'Не удалось собрать букет'));
    },
  });

  const directIssueMut = useMutation({
    mutationFn: async (item: OrderItemDto) => {
      const remaining = item.quantity - item.quantityIssued;
      if (remaining <= 0) throw new Error('Нечего выдавать');
      await directIssueOrderItem(order.id, {
        orderItemId: item.id,
        quantity: remaining,
        expectedOrderVersion: order.version,
      });
    },
    onSuccess: async () => {
      setMessage('Позиция выдана');
      setError(null);
      await invalidateAfterBouquetStockMutation(queryClient);
      await refreshOrder();
    },
    onError: (err) => setError(userFacingError(err, 'Не удалось выдать')),
  });

  if (terminal && (order.assembledBouquets?.length ?? 0) === 0) return null;

  return (
    <section className="overflow-hidden rounded-[28px] border border-border bg-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold">Сборка и готовые букеты</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Соберите каждое изделие отдельно. Фактический состав можно изменить перед подтверждением.
        </p>
      </header>

      <div className="space-y-4 p-4">
        {message ? (
          <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
        ) : null}
        {error ? (
          <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
        ) : null}

        {order.items.map((item) => {
          const assembled = assembledByItem.get(item.id) ?? [];
          const doneUnits =
            item.itemType === OrderItemType.BOUQUET
              ? Math.max(item.quantityAssembled, assembled.length)
              : item.quantityIssued;
          const needUnits = item.quantity;
          const remaining = Math.max(0, needUnits - doneUnits);
          const planned = plannedComponents(item);
          const isAssembling = assemblingItemId === item.id;

          return (
            <div
              key={item.id}
              className="rounded-2xl border border-border/80 bg-background/60 px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {item.nameSnapshot}{' '}
                    <span className="text-muted-foreground">× {item.quantity}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.itemType === OrderItemType.BOUQUET
                      ? `Собрано ${doneUnits} из ${needUnits}`
                      : `Выдано ${item.quantityIssued} из ${needUnits}`}
                    {item.compositionPreview ? ` · ${item.compositionPreview}` : null}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    remaining === 0
                      ? 'bg-success-soft text-success-fg'
                      : 'bg-warn-soft text-warn-fg',
                  )}
                >
                  {remaining === 0 ? 'Готово' : `Осталось ${remaining}`}
                </span>
              </div>

              {planned.length > 0 ? (
                <div className="mt-3 space-y-1">
                  {planned.map((c) => {
                    const req = reqByProduct.get(c.productId);
                    return (
                      <StatRow
                        key={c.productId}
                        label={`${c.name} (план ${c.quantity})`}
                        value={
                          req
                            ? `резерв ${req.reservedQuantity} · нехватка ${req.shortageQuantity}`
                            : '—'
                        }
                      />
                    );
                  })}
                </div>
              ) : null}

              {assembled.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {assembled.map((b) => (
                    <li
                      key={b.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{b.number}</span>
                        <AssembledBouquetStatusBadge status={b.status} />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedBouquetId(b.id)}
                      >
                        Открыть
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {!terminal && remaining > 0 && itemNeedsAssembly(item) ? (
                <div className="mt-3 space-y-3">
                  {isAssembling ? (
                    <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-3">
                      <p className="text-sm font-medium">Фактический состав</p>
                      {planned.map((c) => (
                        <div key={c.productId} className="grid gap-1 sm:grid-cols-[1fr_6rem]">
                          <Label className="text-sm">{c.name}</Label>
                          <Input
                            inputMode="numeric"
                            value={draftQty[c.productId] ?? String(c.quantity)}
                            onChange={(e) =>
                              setDraftQty((prev) => ({
                                ...prev,
                                [c.productId]: e.target.value.replace(/[^\d]/g, ''),
                              }))
                            }
                          />
                        </div>
                      ))}
                      {(pendingOverride || allowOverride) && canOverride ? (
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={allowOverride}
                            onChange={(e) => setAllowOverride(e.target.checked)}
                          />
                          Подтверждаю использование цветов из резерва срочных заказов
                        </label>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {canAssemble ? (
                          <Button
                            type="button"
                            size="sm"
                            disabled={assembleMut.isPending}
                            onClick={() => assembleMut.mutate(item)}
                          >
                            Подтвердить сборку
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={assembleMut.isPending}
                          onClick={() => setAssemblingItemId(null)}
                        >
                          Отмена
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {canAssemble && item.itemType === OrderItemType.BOUQUET ? (
                        <Button type="button" size="sm" onClick={() => openAssemble(item)}>
                          Собрать изделие
                        </Button>
                      ) : null}
                      {canAssemble && item.itemType === OrderItemType.PRODUCT ? (
                        <Button type="button" size="sm" onClick={() => openAssemble(item)}>
                          Собрать как букет
                        </Button>
                      ) : null}
                      {canIssue && item.itemType === OrderItemType.PRODUCT ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={directIssueMut.isPending}
                          onClick={() => directIssueMut.mutate(item)}
                        >
                          Выдать без сборки
                        </Button>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}

            </div>
          );
        })}

        {(order.assembledBouquets ?? []).filter((b) => !b.orderItemId).length > 0 ? (
          <div className="text-xs text-muted-foreground">Витринные букеты смотрите в расшифровке склада.</div>
        ) : null}

        {selectedBouquetId ? (
          <AssembledBouquetPanel
            bouquetId={selectedBouquetId}
            onClose={() => setSelectedBouquetId(null)}
            onChanged={async () => {
              await refreshOrder();
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
