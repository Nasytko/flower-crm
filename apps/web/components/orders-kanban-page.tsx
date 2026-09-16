'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useDraggable } from '@dnd-kit/core';
import { CalendarDays, Package, SlidersHorizontal, Truck } from 'lucide-react';
import {
  FulfillmentType,
  FULFILLMENT_TYPE_LABELS_RU,
  OrderStatus,
  Permission,
  orderStatusLabelRu,
  type OrderListItem,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { changeOrderStatus, getBusinessTime, listOrders } from '@/lib/api/orders';
import { userFacingError } from '@/lib/api/error-messages';
import { queryKeys } from '@/lib/query-keys';
import { invalidateStockViews } from '@/lib/query-invalidation';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  ListToolbar,
  PageHeader,
  ToolbarChip,
  ToolbarDivider,
  ToolbarRow,
  ToolbarSearch,
} from '@/components/ui/page-header';
import { FilterSelect } from '@/components/ui/searchable-select';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { cn } from '@/lib/utils';

type FulfillmentFilter = 'all' | FulfillmentType;
type TimePreset = 'all' | 'without' | 'morning' | 'afternoon' | 'evening';
type SearchScope = 'all' | 'day';

const KANBAN_STATUSES = [OrderStatus.NEW, OrderStatus.READY, OrderStatus.COMPLETED] as const;

const TIME_PRESETS: Record<
  Exclude<TimePreset, 'all' | 'without'>,
  { timeFrom: string; timeTo: string }
> = {
  morning: { timeFrom: '09:00', timeTo: '12:00' },
  afternoon: { timeFrom: '12:00', timeTo: '17:00' },
  evening: { timeFrom: '17:00', timeTo: '22:00' },
};

const TIME_LABELS: Record<TimePreset, string> = {
  all: 'Любое время',
  without: 'Без времени',
  morning: 'Утро 09–12',
  afternoon: 'День 12–17',
  evening: 'Вечер 17–22',
};

function shiftDate(iso: string, days: number): string {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function formatDateRu(iso: string): string {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

function formatDateShortRu(iso: string): string {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatTimeRange(from: string | null, to: string | null): string {
  if (!from && !to) return 'Время не указано';
  if (from && to) return `${from}–${to}`;
  if (from) return `~${from}`;
  return to ? `~${to}` : 'Время не указано';
}

function attentionLabel(attention: OrderListItem['attention']): string | null {
  if (attention === 'overdue') return 'Просрочен';
  if (attention === 'attention') return 'Внимание';
  if (attention === 'past_date') return 'Прошлая дата';
  return null;
}

function columnTitle(status: OrderStatus, fulfillmentType: FulfillmentFilter): string {
  if (fulfillmentType === 'all') {
    if (status === OrderStatus.NEW) return 'Новые';
    if (status === OrderStatus.READY) return 'Готовы';
    return 'Завершённые';
  }
  const sample =
    fulfillmentType === FulfillmentType.DELIVERY
      ? FulfillmentType.DELIVERY
      : FulfillmentType.PICKUP;
  if (status === OrderStatus.NEW) return 'Новые';
  return orderStatusLabelRu(status, sample);
}

function primaryStatusAction(order: OrderListItem): { status: OrderStatus; label: string } | null {
  if (order.status === OrderStatus.NEW) {
    return {
      status: OrderStatus.READY,
      label:
        order.fulfillmentType === FulfillmentType.DELIVERY ? 'Готов к доставке' : 'Готов к выдаче',
    };
  }
  if (order.status === OrderStatus.READY) {
    return {
      status: OrderStatus.COMPLETED,
      label: order.fulfillmentType === FulfillmentType.DELIVERY ? 'Доставлен' : 'Выдан',
    };
  }
  return null;
}

export function OrdersKanbanPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission(Permission.ORDERS_CREATE);
  const canStatus = hasPermission(Permission.ORDERS_STATUS);
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const businessTimeQuery = useQuery({
    queryKey: queryKeys.businessTime,
    queryFn: getBusinessTime,
    staleTime: 60_000,
  });

  const businessDate = businessTimeQuery.data?.businessDate;
  const dateParam = searchParams.get('date');
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : businessDate;

  useEffect(() => {
    if (!businessDate) return;
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('date', businessDate);
    router.replace(`/app/orders?${next.toString()}`);
  }, [businessDate, dateParam, router, searchParams]);

  const fulfillmentFilter = (searchParams.get('type') as FulfillmentFilter | null) ?? 'all';
  const timePreset = (searchParams.get('time') as TimePreset | null) ?? 'all';
  const searchFromUrl = searchParams.get('q')?.trim() ?? '';
  const searchScope: SearchScope = searchParams.get('scope') === 'day' ? 'day' : 'all';
  const mobileStatus =
    (searchParams.get('col') as (typeof KANBAN_STATUSES)[number] | null) ?? OrderStatus.NEW;

  const [searchDraft, setSearchDraft] = useState(searchFromUrl);
  const [searchSyncedFromUrl, setSearchSyncedFromUrl] = useState(searchFromUrl);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState<OrderListItem | null>(null);
  if (searchFromUrl !== searchSyncedFromUrl) {
    setSearchSyncedFromUrl(searchFromUrl);
    setSearchDraft(searchFromUrl);
  }

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === '' || value === 'all') next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `/app/orders?${qs}` : '/app/orders');
    },
    [router, searchParams],
  );

  useEffect(() => {
    const trimmed = searchDraft.trim();
    if (trimmed === searchFromUrl) return;
    const handle = window.setTimeout(() => {
      setParams({
        q: trimmed.length >= 2 ? trimmed : null,
        scope: trimmed.length >= 2 && searchScope === 'day' ? 'day' : null,
      });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchDraft, searchFromUrl, searchScope, setParams]);

  const activeSearch = searchFromUrl.length >= 2 ? searchFromUrl : '';
  const crossDaySearch = Boolean(activeSearch) && searchScope === 'all';

  const listParams = useMemo(() => {
    if (!activeSearch && !date) return null;
    if (activeSearch && searchScope === 'day' && !date) return null;
    const preset =
      timePreset !== 'all' && timePreset !== 'without' ? TIME_PRESETS[timePreset] : null;
    return {
      date: crossDaySearch ? undefined : date,
      search: activeSearch || undefined,
      fulfillmentType:
        fulfillmentFilter === 'all' ? undefined : (fulfillmentFilter as FulfillmentType),
      withoutTime: timePreset === 'without' ? true : undefined,
      timeFrom: preset?.timeFrom,
      timeTo: preset?.timeTo,
      limit: 200,
    };
  }, [activeSearch, crossDaySearch, date, fulfillmentFilter, searchScope, timePreset]);

  const ordersQuery = useQuery({
    queryKey: queryKeys.orders(listParams ?? { pending: true }),
    queryFn: () => listOrders(listParams!),
    enabled: Boolean(listParams),
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const orderItems = ordersQuery.data?.items;
  const summary = ordersQuery.data?.summary;
  const byStatus = useMemo(() => {
    const map: Record<(typeof KANBAN_STATUSES)[number], OrderListItem[]> = {
      [OrderStatus.NEW]: [],
      [OrderStatus.READY]: [],
      [OrderStatus.COMPLETED]: [],
    };
    for (const item of orderItems ?? []) {
      if (
        item.status === OrderStatus.NEW ||
        item.status === OrderStatus.READY ||
        item.status === OrderStatus.COMPLETED
      ) {
        map[item.status].push(item);
      }
    }
    return map;
  }, [orderItems]);

  const itemById = useMemo(() => {
    const map = new Map<string, OrderListItem>();
    for (const item of orderItems ?? []) map.set(item.id, item);
    return map;
  }, [orderItems]);

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: OrderStatus; expectedVersion: number }) =>
      changeOrderStatus(input.id, {
        status: input.status,
        expectedVersion: input.expectedVersion,
      }),
    onSuccess: async () => {
      setStatusError(null);
      await invalidateStockViews(queryClient);
    },
    onError: (err) => {
      setStatusError(userFacingError(err, 'Не удалось сменить статус'));
    },
  });

  const requestStatusChange = useCallback(
    (order: OrderListItem, targetStatus: OrderStatus) => {
      if (!canStatus || statusMutation.isPending) return;
      if (targetStatus === order.status) return;
      if (
        order.hasShortage &&
        (targetStatus === OrderStatus.READY || targetStatus === OrderStatus.COMPLETED)
      ) {
        setStatusError('Заказ нельзя отметить готовым: не хватает товара.');
        return;
      }
      if (targetStatus === OrderStatus.COMPLETED) {
        setConfirmComplete(order);
        return;
      }
      statusMutation.mutate({
        id: order.id,
        status: targetStatus,
        expectedVersion: order.version,
      });
    },
    [canStatus, statusMutation, setConfirmComplete],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const onDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    if (!canStatus || statusMutation.isPending) return;
    const orderId = String(event.active.id);
    const overId = event.over?.id ? String(event.over.id) : null;
    if (!overId) return;

    const order = itemById.get(orderId);
    if (!order) return;

    const targetStatus = (KANBAN_STATUSES as readonly string[]).includes(overId)
      ? (overId as OrderStatus)
      : itemById.get(overId)?.status;
    if (
      !targetStatus ||
      targetStatus === order.status ||
      (targetStatus !== OrderStatus.NEW &&
        targetStatus !== OrderStatus.READY &&
        targetStatus !== OrderStatus.COMPLETED)
    ) {
      return;
    }
    requestStatusChange(order, targetStatus);
  };

  const activeOrder = activeId ? (itemById.get(activeId) ?? null) : null;

  if (businessTimeQuery.isLoading || !date) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  const emptyMessage = activeSearch
    ? crossDaySearch
      ? `По запросу «${activeSearch}» ничего не найдено`
      : `На ${formatDateRu(date)} по запросу «${activeSearch}» ничего не найдено`
    : `На ${formatDateRu(date)} заказов пока нет`;

  const mobileTabStatus = (KANBAN_STATUSES as readonly string[]).includes(mobileStatus)
    ? mobileStatus
    : OrderStatus.NEW;
  const mobileItems = byStatus[mobileTabStatus] ?? [];

  const cardProps = {
    showDate: crossDaySearch,
    canStatus,
    statusPending: statusMutation.isPending,
    onStatusAction: requestStatusChange,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Заказы"
        description={
          crossDaySearch ? 'Поиск по всем датам исполнения' : 'Канбан по дате исполнения'
        }
        actions={
          canCreate ? (
            <Button
              type="button"
              className="min-h-10 w-full sm:w-auto"
              onClick={() => router.push(`/app/orders/new?date=${date}`)}
            >
              + Новый заказ
            </Button>
          ) : null
        }
      />

      <ListToolbar>
        <ToolbarRow>
          <ToolbarSearch
            value={searchDraft}
            onChange={setSearchDraft}
            placeholder="Поиск: номер, имя, телефон..."
            aria-label="Поиск заказов"
          />
          {activeSearch ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <ToolbarChip
                active={searchScope === 'all'}
                onClick={() => setParams({ scope: null })}
              >
                Все дни
              </ToolbarChip>
              <ToolbarChip
                active={searchScope === 'day'}
                onClick={() => setParams({ scope: 'day' })}
              >
                Этот день
              </ToolbarChip>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 text-muted-foreground"
                onClick={() => {
                  setSearchDraft('');
                  setParams({ q: null, scope: null });
                }}
              >
                Сбросить
              </Button>
            </div>
          ) : null}
        </ToolbarRow>

        <ToolbarRow divided className={cn(crossDaySearch && 'pointer-events-none opacity-50')}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="soft"
              size="sm"
              className="h-9 min-w-9 px-0"
              disabled={crossDaySearch}
              aria-label="Предыдущий день"
              onClick={() => setParams({ date: shiftDate(date, -1) })}
            >
              ←
            </Button>
            <div className="relative min-w-[9.5rem]">
              <div className="flex h-9 items-center justify-center rounded-full bg-muted px-3.5 text-sm font-medium tabular-nums">
                {formatDateRu(date)}
              </div>
              <label className="absolute inset-0 cursor-pointer opacity-0">
                <span className="sr-only">Выбрать дату</span>
                <input
                  type="date"
                  className="h-full w-full cursor-pointer"
                  value={date}
                  disabled={crossDaySearch}
                  onChange={(e) => {
                    if (e.target.value) setParams({ date: e.target.value });
                  }}
                />
              </label>
            </div>
            <Button
              type="button"
              variant="soft"
              size="sm"
              className="h-9 min-w-9 px-0"
              disabled={crossDaySearch}
              aria-label="Следующий день"
              onClick={() => setParams({ date: shiftDate(date, 1) })}
            >
              →
            </Button>
            <ToolbarChip
              disabled={crossDaySearch}
              active={date === businessDate}
              onClick={() => setParams({ date: businessDate ?? date })}
            >
              Сегодня
            </ToolbarChip>
            <ToolbarChip
              disabled={crossDaySearch}
              active={date === shiftDate(businessDate ?? date, 1)}
              onClick={() => setParams({ date: shiftDate(businessDate ?? date, 1) })}
            >
              Завтра
            </ToolbarChip>
          </div>

          <ToolbarDivider />

          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Тип исполнения"
          >
            {(
              [
                { value: 'all' as const, label: `Все${summary ? ` · ${summary.total}` : ''}` },
                {
                  value: FulfillmentType.PICKUP,
                  label: `Самовывоз${summary ? ` · ${summary.pickup}` : ''}`,
                },
                {
                  value: FulfillmentType.DELIVERY,
                  label: `Доставка${summary ? ` · ${summary.delivery}` : ''}`,
                },
              ] as const
            ).map((opt) => (
              <ToolbarChip
                key={opt.value}
                active={fulfillmentFilter === opt.value}
                onClick={() => setParams({ type: opt.value === 'all' ? null : opt.value })}
              >
                {opt.label}
              </ToolbarChip>
            ))}
          </div>

          <ToolbarDivider className="hidden lg:block" />

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 lg:hidden"
            aria-label="Фильтры"
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal className="size-4" />
            Время
            {timePreset !== 'all' ? (
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                !
              </span>
            ) : null}
          </Button>
          <div className="hidden lg:block">
            <FilterSelect
              ariaLabel="Время"
              className="min-w-[150px]"
              value={timePreset}
              onChange={(next) => setParams({ time: next === 'all' ? null : next })}
              options={(Object.keys(TIME_LABELS) as TimePreset[]).map((value) => ({
                value,
                label: TIME_LABELS[value],
              }))}
            />
          </div>
        </ToolbarRow>
      </ListToolbar>

      <ResponsiveDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Фильтры заказов"
        size="sheet"
        footer={
          <Button type="button" className="w-full" onClick={() => setFiltersOpen(false)}>
            Готово
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Время</p>
            <div className="flex flex-col gap-2">
              {(Object.keys(TIME_LABELS) as TimePreset[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    'min-h-11 rounded-2xl px-4 text-left text-sm font-medium',
                    timePreset === value ? 'bg-primary text-primary-foreground' : 'bg-muted',
                  )}
                  onClick={() => setParams({ time: value === 'all' ? null : value })}
                >
                  {TIME_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" aria-hidden />
            Дата выбирается стрелками или нажатием на календарь в центре.
          </p>
        </div>
      </ResponsiveDialog>

      {statusError ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{statusError}</p>
      ) : null}

      {ordersQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка заказов...</div>
      ) : ordersQuery.isError ? (
        <div className="space-y-3 rounded-[28px] border border-border bg-card p-8 text-sm">
          <p className="text-danger-fg">Не удалось загрузить заказы</p>
          <Button type="button" variant="outline" onClick={() => void ordersQuery.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (orderItems?.length ?? 0) === 0 ? (
        <div className="space-y-4 rounded-[28px] border border-border bg-card p-8 text-center sm:p-10">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          {canCreate && !activeSearch ? (
            <Button type="button" onClick={() => router.push(`/app/orders/new?date=${date}`)}>
              + Создать заказ
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="hidden lg:block">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              <div className="grid gap-4 lg:grid-cols-3">
                {KANBAN_STATUSES.map((status) => {
                  const columnItems = byStatus[status] ?? [];
                  return (
                    <KanbanColumn
                      key={status}
                      status={status}
                      title={columnTitle(status, fulfillmentFilter)}
                      count={summary?.byStatus[status] ?? columnItems.length}
                      items={columnItems}
                      canDrag={
                        canStatus && !statusMutation.isPending && status !== OrderStatus.COMPLETED
                      }
                      disabledDrop={!canStatus || statusMutation.isPending}
                      {...cardProps}
                    />
                  );
                })}
              </div>
              <DragOverlay>
                {activeOrder ? <OrderCard order={activeOrder} overlay {...cardProps} /> : null}
              </DragOverlay>
            </DndContext>
          </div>

          <div className="space-y-3 lg:hidden">
            <div
              className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1"
              role="tablist"
              aria-label="Статус заказов"
            >
              {KANBAN_STATUSES.map((status) => {
                const count = summary?.byStatus[status] ?? byStatus[status].length;
                const selected = mobileTabStatus === status;
                return (
                  <button
                    key={status}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={cn(
                      'min-h-11 rounded-xl px-2 text-center text-xs font-semibold transition-colors sm:text-sm',
                      selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground',
                    )}
                    onClick={() => setParams({ col: status === OrderStatus.NEW ? null : status })}
                  >
                    <span className="block truncate">{columnTitle(status, fulfillmentFilter)}</span>
                    <span className="tabular-nums opacity-80">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-2" role="tabpanel">
              {mobileItems.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
                  Нет заказов
                </div>
              ) : (
                mobileItems.map((order) => (
                  <OrderCard key={order.id} order={order} {...cardProps} />
                ))
              )}
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(confirmComplete)}
        title={confirmComplete ? `Завершить заказ ${confirmComplete.number}?` : 'Завершить заказ?'}
        description="Заказ будет отмечен выполненным, товар спишется со склада по FIFO."
        confirmLabel="Завершить"
        busy={statusMutation.isPending}
        onCancel={() => setConfirmComplete(null)}
        onConfirm={() => {
          if (!confirmComplete) return;
          const order = confirmComplete;
          setConfirmComplete(null);
          statusMutation.mutate({
            id: order.id,
            status: OrderStatus.COMPLETED,
            expectedVersion: order.version,
          });
        }}
      />
    </div>
  );
}

function KanbanColumn({
  status,
  title,
  count,
  items,
  canDrag,
  disabledDrop,
  showDate,
  canStatus,
  statusPending,
  onStatusAction,
}: {
  status: OrderStatus;
  title: string;
  count: number;
  items: OrderListItem[];
  canDrag: boolean;
  disabledDrop: boolean;
  showDate: boolean;
  canStatus: boolean;
  statusPending: boolean;
  onStatusAction: (order: OrderListItem, status: OrderStatus) => void;
}): ReactElement {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    disabled: disabledDrop,
  });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex min-h-[420px] flex-col rounded-[28px] border border-border bg-card',
        isOver && 'ring-2 ring-primary/40',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold tabular-nums">
          {count}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-2 p-3">
        {items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border/80 px-3 py-10 text-center text-xs text-muted-foreground">
            Нет заказов
          </div>
        ) : (
          items.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              showDate={showDate}
              canStatus={canStatus}
              statusPending={statusPending}
              onStatusAction={onStatusAction}
              draggable={canDrag && order.status !== OrderStatus.COMPLETED}
            />
          ))
        )}
      </div>
    </section>
  );
}

function FulfillmentBadge({ type }: { type: FulfillmentType }): ReactElement {
  const isDelivery = type === FulfillmentType.DELIVERY;
  const Icon = isDelivery ? Truck : Package;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tracking-wide',
        isDelivery
          ? 'bg-[#e8f1ff] text-[#1d4ed8] ring-1 ring-[#bfdbfe]'
          : 'bg-[#ecfdf3] text-[#067647] ring-1 ring-[#abefc6]',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden strokeWidth={2.25} />
      {FULFILLMENT_TYPE_LABELS_RU[type]}
    </span>
  );
}

function telHref(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  return `tel:${digits || trimmed}`;
}

function OrderCard({
  order,
  draggable = false,
  overlay = false,
  showDate = false,
  canStatus = false,
  statusPending = false,
  onStatusAction,
}: {
  order: OrderListItem;
  draggable?: boolean;
  overlay?: boolean;
  showDate?: boolean;
  canStatus?: boolean;
  statusPending?: boolean;
  onStatusAction?: (order: OrderListItem, status: OrderStatus) => void;
}): ReactElement {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    disabled: !draggable || overlay,
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  const badge = attentionLabel(order.attention);
  const action = primaryStatusAction(order);
  const blockedByShortage =
    order.hasShortage &&
    action &&
    (action.status === OrderStatus.READY || action.status === OrderStatus.COMPLETED);

  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      style={overlay ? undefined : style}
      className={cn(
        'rounded-2xl border border-border/80 bg-background p-3 shadow-sm transition-shadow',
        (isDragging || overlay) && 'opacity-90 shadow-md ring-1 ring-primary/30',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
      {...(draggable && !overlay ? { ...listeners, ...attributes } : {})}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold tabular-nums leading-tight">
            {formatTimeRange(order.fulfillmentTimeFrom, order.fulfillmentTimeTo)}
          </p>
          <div className="mt-1">
            <FulfillmentBadge type={order.fulfillmentType} />
          </div>
        </div>
        <div className="min-w-0 text-right">
          <Link
            href={`/app/orders/${order.id}`}
            className="text-sm font-semibold hover:underline focus-visible:underline"
            onClick={(e) => {
              if (draggable) e.stopPropagation();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {order.number}
          </Link>
          {showDate ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDateShortRu(order.fulfillmentDate)}
            </p>
          ) : null}
        </div>
      </div>

      {(badge || order.hasShortage) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {badge ? (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                order.attention === 'overdue' || order.attention === 'past_date'
                  ? 'bg-danger-soft text-danger-fg'
                  : 'bg-warn-soft text-warn-fg',
              )}
            >
              {badge}
            </span>
          ) : null}
          {order.hasShortage ? (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn-fg">
              Не хватает · {order.shortageProductCount}
            </span>
          ) : null}
        </div>
      )}

      <a
        href={telHref(order.effectiveRecipientPhone)}
        className="mt-2 block truncate text-sm font-semibold underline-offset-2 hover:underline focus-visible:underline"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {order.effectiveRecipientPhone}
      </a>
      {order.effectiveRecipientName.trim() ? (
        <p className="truncate text-sm text-muted-foreground">{order.effectiveRecipientName}</p>
      ) : null}
      <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
        {order.compositionSummary || 'Без состава'}
      </p>
      {order.fulfillmentType === FulfillmentType.DELIVERY && order.deliveryAddressText ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {order.deliveryAddressText}
        </p>
      ) : null}
      <p className="mt-2 text-sm font-semibold tabular-nums">{order.total} BYN</p>

      {canStatus && action && onStatusAction && !overlay ? (
        <div className="mt-3 flex flex-wrap gap-2" onPointerDown={(e) => e.stopPropagation()}>
          <Button
            type="button"
            size="sm"
            className="min-h-10 flex-1"
            disabled={statusPending || Boolean(blockedByShortage)}
            title={blockedByShortage ? 'Не хватает товара' : undefined}
            onClick={() => onStatusAction(order, action.status)}
          >
            {action.label}
          </Button>
          {order.status === OrderStatus.READY ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-10"
              disabled={statusPending}
              onClick={() => onStatusAction(order, OrderStatus.NEW)}
            >
              В новые
            </Button>
          ) : null}
          <Link
            href={`/app/orders/${order.id}`}
            className="inline-flex min-h-10 items-center justify-center rounded-full bg-muted px-3 text-xs font-medium hover:bg-border/80"
            onClick={(e) => e.stopPropagation()}
          >
            Открыть
          </Link>
        </div>
      ) : null}
    </article>
  );
}
