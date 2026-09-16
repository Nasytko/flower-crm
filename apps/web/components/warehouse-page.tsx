'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Permission,
  PRODUCT_TYPE_LABELS_RU,
  ProductType,
  STOCK_MOVEMENT_TYPE_LABELS_RU,
  UNIT_LABELS_RU,
  Unit,
  type ProductListItem,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import {
  createProduct,
  listProducts,
  listStockMovements,
  updateProduct,
  writeOffStock,
} from '@/lib/api/products';
import { getActiveInventory } from '@/lib/api/inventories';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ListToolbar,
  PageHeader,
  ToolbarDivider,
  ToolbarRow,
  ToolbarSearch,
} from '@/components/ui/page-header';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { FilterSelect, SearchableSelect } from '@/components/ui/searchable-select';
import { StatRow } from '@/components/ui/stat-row';
import { userFacingError } from '@/lib/api/error-messages';
import { cn } from '@/lib/utils';

type ActiveFilter = 'true' | 'false' | 'all';
type TypeFilter = '' | ProductType;

export function WarehousePage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCTS_MANAGE);
  const canWriteOff = hasPermission(Permission.INVENTORY_ADJUST);
  const canViewPurchase = hasPermission(Permission.PURCHASE_PRICE_VIEW);
  const canViewMovements = hasPermission(Permission.INVENTORY_VIEW);
  const canViewSupplies = hasPermission(Permission.SUPPLIES_VIEW);
  const canCreateSupplies = hasPermission(Permission.SUPPLIES_CREATE);
  const canViewInventory = hasPermission(Permission.INVENTORY_VIEW);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('true');
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProductListItem | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<ProductListItem | null>(null);
  const [historyProduct, setHistoryProduct] = useState<ProductListItem | null>(null);

  const listParams = useMemo(
    () => ({
      search: searchApplied || undefined,
      type: typeFilter || undefined,
      isActive: activeFilter,
      page,
      limit: 50,
    }),
    [searchApplied, typeFilter, activeFilter, page],
  );

  const productsQuery = useQuery({
    queryKey: queryKeys.products(listParams),
    queryFn: () => listProducts(listParams),
  });

  const activeInventoryQuery = useQuery({
    queryKey: queryKeys.activeInventory,
    queryFn: getActiveInventory,
    enabled: canViewInventory,
  });
  const activeInventory = activeInventoryQuery.data ?? null;
  const stockFrozen = Boolean(activeInventory);

  const invalidateProducts = async () => {
    await queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const createMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: async () => {
      setCreateOpen(false);
      setMessage('Товар создан');
      setError(null);
      await invalidateProducts();
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка создания'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateProduct>[1] }) =>
      updateProduct(id, data),
    onSuccess: async () => {
      setEditing(null);
      setMessage('Товар обновлён');
      setError(null);
      await invalidateProducts();
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка обновления'));
    },
  });

  const writeOffMutation = useMutation({
    mutationFn: ({ id, quantity, reason }: { id: string; quantity: number; reason: string }) =>
      writeOffStock(id, { quantity, reason }),
    onSuccess: async () => {
      setWriteOffTarget(null);
      setMessage('Списание выполнено');
      setError(null);
      await invalidateProducts();
      if (historyProduct) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.stockMovements(historyProduct.id),
        });
      }
    },
    onError: (err) => {
      setError(userFacingError(err, 'Ошибка списания'));
    },
  });

  const applySearch = () => {
    setPage(1);
    setSearchApplied(search.trim());
  };

  const items = productsQuery.data?.items ?? [];
  const total = productsQuery.data?.total ?? 0;
  const limit = productsQuery.data?.limit ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const secondaryLinkClass =
    'inline-flex h-9 items-center justify-center rounded-full bg-muted px-3.5 text-sm font-medium text-foreground hover:bg-border/80';

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Склад"
        description="Номенклатура, остатки и списания"
        actions={
          canManage ? (
            <Button
              type="button"
              className="min-h-10 w-full sm:w-auto"
              onClick={() => setCreateOpen(true)}
            >
              + Товар
            </Button>
          ) : null
        }
      />

      <ListToolbar>
        <ToolbarRow>
          <ToolbarSearch
            id="warehouse-search"
            value={search}
            onChange={setSearch}
            onSubmit={applySearch}
            placeholder="Поиск по названию или SKU..."
            aria-label="Поиск"
          />
          <FilterSelect
            ariaLabel="Тип"
            className="min-w-[130px] flex-1 sm:flex-none sm:min-w-[150px]"
            value={typeFilter}
            onChange={(next) => {
              setTypeFilter(next as TypeFilter);
              setPage(1);
            }}
            options={[
              { value: '', label: 'Все типы' },
              { value: ProductType.FLOWER, label: 'Цветы' },
              { value: ProductType.SERVICE, label: 'Услуги' },
            ]}
          />
          <FilterSelect
            ariaLabel="Статус"
            className="min-w-[130px] flex-1 sm:flex-none sm:min-w-[150px]"
            value={activeFilter}
            onChange={(next) => {
              setActiveFilter(next as ActiveFilter);
              setPage(1);
            }}
            options={[
              { value: 'true', label: 'Активные' },
              { value: 'false', label: 'Неактивные' },
              { value: 'all', label: 'Все' },
            ]}
          />
          <Button type="button" variant="soft" className="h-10" onClick={applySearch}>
            Найти
          </Button>
        </ToolbarRow>
        <ToolbarRow divided className="gap-1.5">
          {canCreateSupplies && !stockFrozen ? (
            <Link href="/app/supplies/new" className={secondaryLinkClass}>
              Поставка
            </Link>
          ) : canCreateSupplies && stockFrozen ? (
            <ToolbarGhost label="Поставка" title="Недоступно во время инвентаризации" />
          ) : (
            <ToolbarGhost label="Поставка" />
          )}

          {canViewSupplies ? (
            <Link href="/app/supplies" className={secondaryLinkClass}>
              Поставки
            </Link>
          ) : (
            <ToolbarGhost label="Поставки" />
          )}

          <ToolbarDivider />

          {canViewInventory ? (
            <Link
              href={activeInventory ? `/app/inventories/${activeInventory.id}` : '/app/inventories'}
              className={secondaryLinkClass}
            >
              Инвентаризация
            </Link>
          ) : (
            <ToolbarGhost label="Инвентаризация" />
          )}
        </ToolbarRow>
      </ListToolbar>

      {activeInventory ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-border bg-primary-soft/60 px-5 py-3 text-sm">
          <p>
            Идёт инвентаризация {activeInventory.numberLabel}. Операции, изменяющие остатки,
            временно недоступны.
          </p>
          <Link
            href={`/app/inventories/${activeInventory.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            Открыть инвентаризацию
          </Link>
        </div>
      ) : null}

      {message ? (
        <p className="rounded-2xl bg-success-soft px-4 py-2 text-sm text-success-fg">{message}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-danger-soft px-4 py-2 text-sm text-danger-fg">{error}</p>
      ) : null}

      <section className="overflow-hidden rounded-[28px] border border-border bg-card shadow-[0_1px_0_rgba(20,24,36,0.04)]">
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold">Товары</h2>
          <p className="text-sm text-muted-foreground">Всего: {total}</p>
        </div>

        {productsQuery.isLoading ? (
          <div className="space-y-4 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="h-12 w-12 animate-pulse rounded-2xl bg-muted" />
                <div className="h-4 flex-1 animate-pulse rounded-full bg-muted" />
              </div>
            ))}
          </div>
        ) : productsQuery.isError ? (
          <div className="space-y-3 p-8 text-sm">
            <p className="text-danger-fg">Не удалось загрузить склад</p>
            <Button type="button" variant="outline" onClick={() => void productsQuery.refetch()}>
              Повторить
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            {searchApplied || typeFilter || activeFilter !== 'true'
              ? 'Ничего не найдено по текущим фильтрам'
              : 'Номенклатура пуста. Добавьте первый товар.'}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Фото</th>
                    <th className="px-3 py-3 font-medium">Название</th>
                    <th className="px-3 py-3 font-medium">В наличии</th>
                    <th className="px-3 py-3 font-medium">В резерве</th>
                    <th className="px-3 py-3 font-medium">Доступно</th>
                    {canViewPurchase ? (
                      <th className="px-3 py-3 font-medium">Ср. закупка</th>
                    ) : null}
                    <th className="px-3 py-3 font-medium">Продажная</th>
                    <th className="px-3 py-3 font-medium">Тип</th>
                    <th className="px-5 py-3 font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((product) => {
                    const stock = productStock(product);
                    return (
                      <tr
                        key={product.id}
                        className={cn(
                          'border-b border-border/80 transition-colors hover:bg-muted/40',
                          !product.isActive && 'opacity-60',
                        )}
                      >
                        <td className="px-5 py-3">
                          <div
                            className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-soft to-muted text-lg text-foreground/70"
                            aria-hidden
                          >
                            {stock.isFlower ? '✿' : '◇'}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-foreground">{product.name}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {product.sku ?? 'без SKU'}
                            {!product.isActive ? ' · неактивен' : ''}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {stock.isFlower && stock.onHand != null ? (
                            <StockBadge quantity={stock.onHand} />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {stock.isFlower && stock.reserved != null ? (
                            stock.reserved
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {stock.isFlower && stock.available != null ? (
                            <StockBadge quantity={stock.available} />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        {canViewPurchase ? (
                          <td className="px-3 py-3 tabular-nums">
                            {purchaseCostLabel(product, stock.isFlower)}
                          </td>
                        ) : null}
                        <td className="px-3 py-3 tabular-nums">
                          {product.salePrice != null ? `${product.salePrice} BYN` : '—'}
                        </td>
                        <td className="px-3 py-3">
                          <TypeBadge type={product.type} />
                        </td>
                        <td className="px-5 py-3">
                          <ProductActions
                            product={product}
                            stockFrozen={stockFrozen}
                            canManage={canManage}
                            canWriteOff={canWriteOff}
                            canViewMovements={canViewMovements}
                            updatePending={updateMutation.isPending}
                            onEdit={() => setEditing(product)}
                            onWriteOff={() => setWriteOffTarget(product)}
                            onHistory={() => setHistoryProduct(product)}
                            onToggleActive={() =>
                              updateMutation.mutate({
                                id: product.id,
                                data: { isActive: !product.isActive },
                              })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 p-3 md:hidden">
              {items.map((product) => {
                const stock = productStock(product);
                return (
                  <div
                    key={product.id}
                    className={cn(
                      'rounded-2xl border border-border/80 px-4 py-3',
                      !product.isActive && 'opacity-60',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-soft to-muted text-base text-foreground/70"
                        aria-hidden
                      >
                        {stock.isFlower ? '✿' : '◇'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground">{product.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {product.sku ?? 'без SKU'}
                          {!product.isActive ? ' · неактивен' : ''}
                        </p>
                      </div>
                      <TypeBadge type={product.type} />
                    </div>
                    <div className="mt-3 space-y-1">
                      <StatRow
                        label="В наличии"
                        value={
                          stock.isFlower && stock.onHand != null ? (
                            <StockBadge quantity={stock.onHand} />
                          ) : (
                            '—'
                          )
                        }
                      />
                      <StatRow
                        label="В резерве"
                        value={stock.isFlower && stock.reserved != null ? stock.reserved : '—'}
                      />
                      <StatRow
                        label="Доступно"
                        value={
                          stock.isFlower && stock.available != null ? (
                            <StockBadge quantity={stock.available} />
                          ) : (
                            '—'
                          )
                        }
                      />
                      {canViewPurchase ? (
                        <StatRow
                          label="Ср. закупка"
                          value={purchaseCostLabel(product, stock.isFlower)}
                        />
                      ) : null}
                      <StatRow
                        label="Продажная"
                        emphasize
                        value={product.salePrice != null ? `${product.salePrice} BYN` : '—'}
                      />
                    </div>
                    <div className="mt-3">
                      <ProductActions
                        product={product}
                        stockFrozen={stockFrozen}
                        canManage={canManage}
                        canWriteOff={canWriteOff}
                        canViewMovements={canViewMovements}
                        updatePending={updateMutation.isPending}
                        onEdit={() => setEditing(product)}
                        onWriteOff={() => setWriteOffTarget(product)}
                        onHistory={() => setHistoryProduct(product)}
                        onToggleActive={() =>
                          updateMutation.mutate({
                            id: product.id,
                            data: { isActive: !product.isActive },
                          })
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Стр. {page} / {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Назад
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <ProductFormDialog
          title="Новый товар"
          submitLabel="Создать"
          onClose={() => setCreateOpen(false)}
          onSubmit={(values) => createMutation.mutate(values)}
          pending={createMutation.isPending}
          allowType
          canViewPurchase={canViewPurchase}
        />
      ) : null}

      {editing ? (
        <ProductFormDialog
          title="Редактирование"
          submitLabel="Сохранить"
          product={editing}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            updateMutation.mutate({
              id: editing.id,
              data: {
                name: values.name,
                sku: values.sku,
                description: values.description,
                purchasePrice:
                  editing.type === ProductType.SERVICE ? values.purchasePrice : undefined,
                salePrice: values.salePrice,
              },
            })
          }
          pending={updateMutation.isPending}
          allowType={false}
          canViewPurchase={canViewPurchase}
        />
      ) : null}

      {writeOffTarget ? (
        <WriteOffDialog
          product={writeOffTarget}
          onClose={() => setWriteOffTarget(null)}
          pending={writeOffMutation.isPending}
          onSubmit={(quantity, reason) =>
            writeOffMutation.mutate({
              id: writeOffTarget.id,
              quantity,
              reason,
            })
          }
        />
      ) : null}

      {historyProduct ? (
        <MovementsSheet product={historyProduct} onClose={() => setHistoryProduct(null)} />
      ) : null}
    </div>
  );
}

function ToolbarGhost({ label, title }: { label: string; title?: string }): ReactElement {
  return (
    <Button
      type="button"
      variant="soft"
      className="h-9"
      disabled
      title={title ?? 'Будет доступно позже'}
    >
      {label}
    </Button>
  );
}

function productStock(product: ProductListItem): {
  isFlower: boolean;
  onHand: number | null | undefined;
  reserved: number | null | undefined;
  available: number | null;
} {
  const isFlower = product.type === ProductType.FLOWER;
  const onHand = product.stock?.quantityOnHand;
  const reserved = product.stock?.quantityReserved;
  const available =
    product.stock?.availableQuantity ??
    (onHand != null && reserved != null ? Math.max(0, onHand - reserved) : null);
  return { isFlower, onHand, reserved, available };
}

function purchaseCostLabel(product: ProductListItem, isFlower: boolean): ReactNode {
  if (isFlower && product.hasUncostedStock) {
    return (
      <span title="Часть остатка не имеет закупочной стоимости" className="cursor-help">
        —
      </span>
    );
  }
  if (isFlower && product.averagePurchaseCost != null) {
    return `${product.averagePurchaseCost} BYN`;
  }
  return '—';
}

function StockBadge({ quantity }: { quantity: number }): ReactElement {
  const empty = quantity === 0;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold tabular-nums',
        empty ? 'bg-danger-soft text-danger-fg' : 'bg-success-soft text-success-fg',
      )}
    >
      {quantity} шт.
    </span>
  );
}

function TypeBadge({ type }: { type: ProductType }): ReactElement {
  const flower = type === ProductType.FLOWER;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
        flower
          ? 'bg-type-flower-bg text-type-flower-fg'
          : 'bg-type-service-bg text-type-service-fg',
      )}
    >
      {PRODUCT_TYPE_LABELS_RU[type]}
    </span>
  );
}

function IconAction({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
}): ReactElement {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="soft"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="text-base text-foreground/80"
    >
      {children}
    </Button>
  );
}

function ProductActions({
  product,
  stockFrozen,
  canManage,
  canWriteOff,
  canViewMovements,
  updatePending,
  onEdit,
  onWriteOff,
  onHistory,
  onToggleActive,
}: {
  product: ProductListItem;
  stockFrozen: boolean;
  canManage: boolean;
  canWriteOff: boolean;
  canViewMovements: boolean;
  updatePending: boolean;
  onEdit: () => void;
  onWriteOff: () => void;
  onHistory: () => void;
  onToggleActive: () => void;
}): ReactElement {
  const isFlower = product.type === ProductType.FLOWER;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canManage ? (
        <IconAction label="Редактировать" onClick={onEdit} disabled={updatePending}>
          ✎
        </IconAction>
      ) : null}
      {canWriteOff && isFlower && product.isActive && !stockFrozen ? (
        <IconAction label="Списать" onClick={onWriteOff}>
          −
        </IconAction>
      ) : null}
      {canWriteOff && isFlower && product.isActive && stockFrozen ? (
        <IconAction label="Недоступно во время инвентаризации" disabled>
          −
        </IconAction>
      ) : null}
      {canViewMovements && isFlower ? (
        <IconAction label="История движений" onClick={onHistory}>
          ◷
        </IconAction>
      ) : null}
      {canManage ? (
        <IconAction
          label={product.isActive ? 'Деактивировать' : 'Активировать'}
          onClick={onToggleActive}
          disabled={updatePending}
        >
          {product.isActive ? '⊘' : '✓'}
        </IconAction>
      ) : null}
    </div>
  );
}

function ProductFormDialog({
  title,
  submitLabel,
  product,
  onClose,
  onSubmit,
  pending,
  allowType,
  canViewPurchase,
}: {
  title: string;
  submitLabel: string;
  product?: ProductListItem;
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    sku?: string | null;
    type: ProductType;
    unit: Unit;
    description?: string | null;
    purchasePrice?: string | null;
    salePrice?: string | null;
  }) => void;
  pending: boolean;
  allowType: boolean;
  canViewPurchase: boolean;
}): ReactElement {
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [type, setType] = useState<ProductType>(product?.type ?? ProductType.FLOWER);
  const [description, setDescription] = useState(product?.description ?? '');
  const [purchasePrice, setPurchasePrice] = useState(product?.purchasePrice ?? '');
  const [salePrice, setSalePrice] = useState(product?.salePrice ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const showPurchasePrice =
    canViewPurchase &&
    (allowType ? type === ProductType.SERVICE : product?.type === ProductType.SERVICE);

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-10"
            onClick={onClose}
          >
            Отмена
          </Button>
          <Button
            type="submit"
            form="product-form"
            className="min-h-11 sm:min-h-10"
            disabled={pending}
          >
            {submitLabel}
          </Button>
        </div>
      }
    >
      <form
        id="product-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length < 2) {
            setLocalError('Укажите название');
            return;
          }
          setLocalError(null);
          const isService = allowType
            ? type === ProductType.SERVICE
            : product?.type === ProductType.SERVICE;
          onSubmit({
            name: name.trim(),
            sku: sku.trim() || null,
            type,
            unit: Unit.PIECE,
            description: description.trim() || null,
            purchasePrice: isService ? purchasePrice.trim() || null : null,
            salePrice: salePrice.trim() || null,
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="product-name">Название *</Label>
          <Input
            id="product-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="product-sku">SKU</Label>
          <Input id="product-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        {allowType ? (
          <div className="space-y-2">
            <Label htmlFor="product-type">Тип *</Label>
            <SearchableSelect
              ariaLabel="Тип товара"
              value={type}
              searchable={false}
              onChange={(next) => setType(next as ProductType)}
              options={Object.values(ProductType).map((value) => ({
                value,
                label: PRODUCT_TYPE_LABELS_RU[value],
                badges: [
                  {
                    text: PRODUCT_TYPE_LABELS_RU[value],
                    tone: value === ProductType.FLOWER ? 'flower' : 'service',
                  },
                ],
              }))}
              triggerClassName="h-11 rounded-full px-4"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Тип: {PRODUCT_TYPE_LABELS_RU[product!.type]} · единица: {UNIT_LABELS_RU[product!.unit]}{' '}
            (нельзя изменить)
          </p>
        )}
        <div className={cn('grid gap-4', showPurchasePrice ? 'sm:grid-cols-2' : '')}>
          {showPurchasePrice ? (
            <div className="space-y-2">
              <Label htmlFor="product-purchase">Себестоимость услуги</Label>
              <Input
                id="product-purchase"
                inputMode="decimal"
                placeholder="12.50"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="product-sale">Цена продажи</Label>
            <Input
              id="product-sale"
              inputMode="decimal"
              placeholder="25.00"
              value={salePrice}
              onChange={(e) => setSalePrice(e.target.value)}
            />
          </div>
        </div>
        {allowType && type === ProductType.FLOWER ? (
          <p className="text-xs text-muted-foreground">
            Закупочная стоимость цветов задаётся в поставках (средняя по остатку).
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="product-description">Описание</Label>
          <textarea
            id="product-description"
            className="min-h-[80px] w-full rounded-3xl border border-border bg-card px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {localError ? <p className="text-sm text-danger-fg">{localError}</p> : null}
      </form>
    </ResponsiveDialog>
  );
}

function WriteOffDialog({
  product,
  onClose,
  onSubmit,
  pending,
}: {
  product: ProductListItem;
  onClose: () => void;
  onSubmit: (quantity: number, reason: string) => void;
  pending: boolean;
}): ReactElement {
  const current = product.stock?.quantityOnHand ?? 0;
  const reserved = product.stock?.quantityReserved ?? 0;
  const available = Math.max(0, current - reserved);
  const [quantityRaw, setQuantityRaw] = useState('1');
  const [reason, setReason] = useState('');
  const [confirmOnce, setConfirmOnce] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const quantity = Number.parseInt(quantityRaw, 10);
  const validQty = Number.isInteger(quantity) && quantity >= 1;
  const next = validQty ? current - quantity : null;
  const exceedsStock = validQty && quantity > current;
  const breaksReserved = validQty && quantity > available;

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title="Списание"
      description={product.name}
      size="sm"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-10"
            onClick={onClose}
          >
            Отмена
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-10"
            disabled={pending || !validQty || exceedsStock || breaksReserved}
            onClick={() => {
              if (!validQty) {
                setLocalError('Укажите целое количество не меньше 1');
                return;
              }
              if (reason.trim().length < 3) {
                setLocalError('Причина не короче 3 символов');
                return;
              }
              if (!confirmOnce) {
                setConfirmOnce(true);
                setLocalError('Подтвердите списание ещё раз');
                return;
              }
              setLocalError(null);
              onSubmit(quantity, reason.trim());
            }}
          >
            {confirmOnce ? 'Подтвердить списание' : 'Списать'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          Текущий остаток: <strong>{current}</strong> шт.
          {reserved > 0 ? ` (резерв ${reserved}, доступно ${available})` : null}
        </p>
        <div className="space-y-2">
          <Label htmlFor="write-off-qty">Количество *</Label>
          <Input
            id="write-off-qty"
            inputMode="numeric"
            placeholder="1"
            value={quantityRaw}
            onChange={(e) => {
              setQuantityRaw(e.target.value.replace(/[^\d]/g, ''));
              setConfirmOnce(false);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="write-off-reason">Причина *</Label>
          <Input
            id="write-off-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            maxLength={500}
            placeholder="Брак, увядание..."
          />
        </div>
        {validQty ? (
          <div className="rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm">
            <div>Было: {current}</div>
            <div>Списать: −{quantity}</div>
            <div>Станет: {next}</div>
          </div>
        ) : null}
        {exceedsStock || breaksReserved ? (
          <p className="text-sm text-danger-fg">
            {exceedsStock
              ? 'Нельзя списать больше текущего остатка'
              : 'Нельзя списать зарезервированное количество'}
          </p>
        ) : null}
        {localError ? <p className="text-sm text-danger-fg">{localError}</p> : null}
      </div>
    </ResponsiveDialog>
  );
}

function MovementsSheet({
  product,
  onClose,
}: {
  product: ProductListItem;
  onClose: () => void;
}): ReactElement {
  const movementsQuery = useQuery({
    queryKey: queryKeys.stockMovements(product.id),
    queryFn: () => listStockMovements(product.id, { page: 1, limit: 50 }),
  });

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title="История движений"
      description={product.name}
      size="lg"
      footer={
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          onClick={onClose}
        >
          Закрыть
        </Button>
      }
    >
      {movementsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      ) : movementsQuery.isError ? (
        <div className="space-y-2 text-sm">
          <p className="text-danger-fg">Не удалось загрузить историю</p>
          <Button type="button" variant="outline" onClick={() => void movementsQuery.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (movementsQuery.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">Движений пока нет</p>
      ) : (
        <ul className="space-y-3">
          {movementsQuery.data!.items.map((item) => (
            <li key={item.id} className="rounded-2xl border border-border px-4 py-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="font-semibold">
                  {item.quantity > 0 ? `+${item.quantity}` : item.quantity}
                </span>
                <span className="text-muted-foreground">после: {item.balanceAfter}</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                {STOCK_MOVEMENT_TYPE_LABELS_RU[item.type]}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {new Date(item.createdAt).toLocaleString('ru-RU')}
                {item.createdByName ? ` · ${item.createdByName}` : ''}
              </div>
              {item.comment ? <p className="mt-2">{item.comment}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </ResponsiveDialog>
  );
}
