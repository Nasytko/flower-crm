'use client';

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FulfillmentType,
  FULFILLMENT_TYPE_LABELS_RU,
  OrderStatus,
  Permission,
  orderStatusLabelRu,
  type OrderDetail,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { changeOrderStatus } from '@/lib/api/orders';
import { userFacingError } from '@/lib/api/error-messages';
import { invalidateStockViews } from '@/lib/query-invalidation';
import { OrderEditor } from '@/components/order-editor';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { StatRow } from '@/components/ui/stat-row';
import { StickyActionBar } from '@/components/ui/sticky-action-bar';
import { cn } from '@/lib/utils';

const SHORTAGE_BLOCK_MSG = 'Заказ нельзя отметить готовым: не хватает товара.';

function attentionLabel(attention: OrderDetail['attention']): string | null {
  if (attention === 'overdue') return 'Просрочен';
  if (attention === 'attention') return 'Внимание';
  if (attention === 'past_date') return 'Прошлая дата';
  return null;
}

function nextStatuses(status: OrderStatus): OrderStatus[] {
  switch (status) {
    case OrderStatus.NEW:
      return [OrderStatus.READY, OrderStatus.CANCELLED];
    case OrderStatus.READY:
      return [OrderStatus.COMPLETED, OrderStatus.NEW, OrderStatus.CANCELLED];
    default:
      return [];
  }
}

type PendingConfirm =
  { kind: 'complete'; status: OrderStatus } | { kind: 'cancel'; status: OrderStatus };

export function OrderDetailPage({ order }: { order: OrderDetail }): ReactElement {
  const { hasPermission } = useAuth();
  const canStatus = hasPermission(Permission.ORDERS_STATUS);
  const canCancel = hasPermission(Permission.ORDERS_CANCEL);
  const canUpdate = hasPermission(Permission.ORDERS_UPDATE);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [version, setVersion] = useState(order.version);
  const [current, setCurrent] = useState(order);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const editable = canUpdate && current.status === OrderStatus.NEW;
  const readOnly = !editable;

  const statusMutation = useMutation({
    mutationFn: (status: OrderStatus) =>
      changeOrderStatus(current.id, { status, expectedVersion: version }),
    onSuccess: async (detail) => {
      setCurrent(detail);
      setVersion(detail.version);
      setError(null);
      setPending(null);
      setMessage(`Статус: ${orderStatusLabelRu(detail.status, detail.fulfillmentType)}`);
      await invalidateStockViews(queryClient);
      await queryClient.invalidateQueries({ queryKey: ['orders', detail.id] });
    },
    onError: (err) => {
      setError(userFacingError(err, 'Не удалось сменить статус'));
      setPending(null);
    },
  });

  const requestStatus = (status: OrderStatus) => {
    const isComplete = status === OrderStatus.COMPLETED;
    const isCancel = status === OrderStatus.CANCELLED;
    const isReady = status === OrderStatus.READY;
    const blockedByShortage = current.hasShortage && (isReady || isComplete);
    if (blockedByShortage) {
      setError(SHORTAGE_BLOCK_MSG);
      return;
    }
    if (isComplete) {
      setPending({ kind: 'complete', status });
      return;
    }
    if (isCancel) {
      setPending({ kind: 'cancel', status });
      return;
    }
    setMessage(null);
    statusMutation.mutate(status);
  };

  const badge = attentionLabel(current.attention);
  const actions = nextStatuses(current.status).filter((status) => {
    if (status === OrderStatus.CANCELLED) return canCancel;
    return canStatus;
  });
  const requirements = current.requirements ?? [];
  const showCost =
    current.actualCost != null || current.hasUncostedConsumption || current.grossProfit != null;

  const statusButton = (status: OrderStatus, fullWidth = false) => {
    const label = orderStatusLabelRu(status, current.fulfillmentType);
    const isComplete = status === OrderStatus.COMPLETED;
    const isCancel = status === OrderStatus.CANCELLED;
    const isReady = status === OrderStatus.READY;
    const blockedByShortage = current.hasShortage && (isReady || isComplete);
    return (
      <Button
        key={status}
        type="button"
        size={fullWidth ? 'default' : 'sm'}
        className={fullWidth ? 'min-h-11 w-full' : undefined}
        variant={isCancel ? 'destructive' : isComplete ? 'default' : 'outline'}
        disabled={statusMutation.isPending || blockedByShortage}
        title={blockedByShortage ? SHORTAGE_BLOCK_MSG : undefined}
        onClick={() => requestStatus(status)}
      >
        {isCancel
          ? 'Отменить'
          : status === OrderStatus.READY
            ? current.fulfillmentType === FulfillmentType.DELIVERY
              ? 'Готов к доставке'
              : 'Готов к выдаче'
            : status === OrderStatus.NEW
              ? 'Вернуть в новые'
              : label}
      </Button>
    );
  };

  return (
    <div className={cn('space-y-6', actions.length > 0 ? 'pb-28 sm:pb-0' : undefined)}>
      <PageHeader
        title={`Заказ ${current.number}`}
        description={
          <p className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="text-muted-foreground underline-offset-2 hover:underline focus-visible:underline"
              onClick={() => router.push(`/app/orders?date=${current.fulfillmentDate}`)}
            >
              ← К заказам
            </button>
            <span>·</span>
            <span>{orderStatusLabelRu(current.status, current.fulfillmentType)}</span>
            <span>·</span>
            <span>{FULFILLMENT_TYPE_LABELS_RU[current.fulfillmentType]}</span>
            {badge ? (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  current.attention === 'overdue' || current.attention === 'past_date'
                    ? 'bg-danger-soft text-danger-fg'
                    : 'bg-warn-soft text-warn-fg',
                )}
              >
                {badge}
              </span>
            ) : null}
            {current.hasShortage ? (
              <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn-fg">
                Не хватает · {current.shortageProductCount}
              </span>
            ) : null}
          </p>
        }
        actions={
          actions.length > 0 ? (
            <div className="hidden flex-wrap gap-2 sm:flex">
              {actions.map((s) => statusButton(s))}
            </div>
          ) : null
        }
      />

      {message ? (
        <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      {!editable && current.status !== OrderStatus.NEW ? (
        <p className="rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Редактирование доступно только для заказов со статусом «Новый».
        </p>
      ) : null}

      {requirements.length > 0 ? (
        <section className="overflow-hidden rounded-[28px] border border-border bg-card">
          <header className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold">Обеспеченность</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Резерв по цветам из снимка состава заказа
            </p>
          </header>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Товар</th>
                  <th className="px-3 py-2.5 font-medium">Нужно</th>
                  <th className="px-3 py-2.5 font-medium">Резерв</th>
                  <th className="px-5 py-2.5 font-medium">Не хватает</th>
                </tr>
              </thead>
              <tbody>
                {requirements.map((row) => {
                  const shortage = row.shortageQuantity > 0;
                  const fullyReserved =
                    !shortage &&
                    row.requiredQuantity > 0 &&
                    row.reservedQuantity >= row.requiredQuantity;
                  return (
                    <tr
                      key={row.productId}
                      className={cn(
                        'border-b border-border/80',
                        shortage && 'bg-warn-soft/60',
                        fullyReserved && 'bg-success-soft/40',
                      )}
                    >
                      <td className="px-5 py-2.5 font-medium">{row.productName}</td>
                      <td className="px-3 py-2.5 tabular-nums">{row.requiredQuantity}</td>
                      <td className="px-3 py-2.5 tabular-nums">{row.reservedQuantity}</td>
                      <td
                        className={cn(
                          'px-5 py-2.5 tabular-nums',
                          shortage ? 'font-semibold text-warn-fg' : 'text-muted-foreground',
                        )}
                      >
                        {row.shortageQuantity}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 p-3 md:hidden">
            {requirements.map((row) => {
              const shortage = row.shortageQuantity > 0;
              return (
                <div
                  key={row.productId}
                  className={cn(
                    'rounded-2xl border border-border/80 px-4 py-3',
                    shortage && 'border-warn-fg/30 bg-warn-soft/50',
                  )}
                >
                  <p className="text-sm font-medium">{row.productName}</p>
                  <div className="mt-2 space-y-1">
                    <StatRow label="Нужно" value={row.requiredQuantity} />
                    <StatRow label="Резерв" value={row.reservedQuantity} />
                    <StatRow
                      label="Не хватает"
                      value={row.shortageQuantity}
                      emphasize={shortage}
                      className={shortage ? 'text-warn-fg' : undefined}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {showCost ? (
        <section className="space-y-2 rounded-[28px] border border-border bg-card px-5 py-4">
          <h2 className="text-sm font-semibold">Фактическая себестоимость</h2>
          {current.hasUncostedConsumption ? (
            <p className="text-sm text-warn-fg">
              Себестоимость неполная: часть списания без закупочной цены.
            </p>
          ) : null}
          {current.actualCost != null ? (
            <p className="text-sm tabular-nums">
              <span className="text-muted-foreground">COGS:</span>{' '}
              <span className="font-semibold">{current.actualCost} BYN</span>
            </p>
          ) : null}
          {current.grossProfit != null ? (
            <p className="text-sm tabular-nums">
              <span className="text-muted-foreground">Валовая прибыль:</span>{' '}
              <span className="font-semibold">{current.grossProfit} BYN</span>
            </p>
          ) : null}
        </section>
      ) : null}

      <OrderEditor
        key={`${current.id}-${version}-${current.status}`}
        mode="edit"
        initial={current}
        readOnly={readOnly}
      />

      {actions.length > 0 ? (
        <StickyActionBar className="sm:hidden">
          {actions.map((status) => statusButton(status, true))}
        </StickyActionBar>
      ) : null}

      <ConfirmDialog
        open={pending?.kind === 'complete'}
        title={`Завершить заказ ${current.number}?`}
        description="Заказ будет отмечен выполненным, товар спишется со склада по FIFO."
        confirmLabel="Завершить"
        busy={statusMutation.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending || pending.kind !== 'complete') return;
          setMessage(null);
          statusMutation.mutate(pending.status);
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'cancel'}
        title={`Отменить заказ ${current.number}?`}
        description="Зарезервированный товар будет освобождён и при необходимости распределён по другим заказам."
        confirmLabel="Отменить заказ"
        tone="danger"
        busy={statusMutation.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending || pending.kind !== 'cancel') return;
          setMessage(null);
          statusMutation.mutate(pending.status);
        }}
      />
    </div>
  );
}
