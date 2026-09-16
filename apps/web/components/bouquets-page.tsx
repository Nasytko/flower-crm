'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { listBouquets } from '@/lib/api/bouquets';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { FilterSelect } from '@/components/ui/searchable-select';
import { ListToolbar, PageHeader, ToolbarRow, ToolbarSearch } from '@/components/ui/page-header';
import { StatRow } from '@/components/ui/stat-row';
import { cn } from '@/lib/utils';

type ActiveFilter = 'true' | 'false' | 'all';

export function BouquetsPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.BOUQUETS_MANAGE);
  const canViewCost = hasPermission(Permission.PURCHASE_PRICE_VIEW);
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('true');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: queryKeys.bouquets({
      page,
      search: searchApplied || undefined,
      isActive: activeFilter,
    }),
    queryFn: () =>
      listBouquets({
        page,
        limit: 50,
        search: searchApplied || undefined,
        isActive: activeFilter,
      }),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Букеты"
        description="Составы и цены букетов"
        actions={
          canManage ? (
            <Button
              type="button"
              className="min-h-10 w-full sm:w-auto"
              onClick={() => router.push('/app/bouquets/new')}
            >
              + Добавить букет
            </Button>
          ) : null
        }
      />

      <ListToolbar>
        <ToolbarRow>
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            onSubmit={() => {
              setPage(1);
              setSearchApplied(search.trim());
            }}
            placeholder="Поиск по названию..."
            aria-label="Поиск букетов"
          />
          <FilterSelect
            ariaLabel="Статус"
            className="min-w-[150px]"
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
          <Button
            type="button"
            variant="soft"
            className="h-10"
            onClick={() => {
              setPage(1);
              setSearchApplied(search.trim());
            }}
          >
            Найти
          </Button>
        </ToolbarRow>
      </ListToolbar>

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        {query.isLoading ? (
          <div className="p-8 text-sm text-muted-foreground">Загрузка...</div>
        ) : query.isError ? (
          <div className="space-y-3 p-8 text-sm">
            <p className="text-danger-fg">Не удалось загрузить букеты</p>
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              Повторить
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">Букетов пока нет</div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Название</th>
                    <th className="px-3 py-3 font-medium">Состав</th>
                    <th className="px-3 py-3 font-medium">Доступно</th>
                    {canViewCost ? (
                      <th className="px-3 py-3 font-medium">Расчётная себестоимость</th>
                    ) : null}
                    <th className="px-3 py-3 font-medium">Цена продажи</th>
                    {canViewCost ? <th className="px-3 py-3 font-medium">Маржа</th> : null}
                    <th className="px-3 py-3 font-medium">Статус</th>
                    <th className="px-5 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} className="border-b border-border/80 hover:bg-muted/40">
                      <td className="px-5 py-3 font-medium">{row.name}</td>
                      <td className="max-w-[280px] px-3 py-3 text-muted-foreground">
                        {row.compositionPreview}
                      </td>
                      <td className="px-3 py-3">
                        <AvailabilityBadge
                          count={row.availableBouquets}
                          inactive={row.hasInactiveComponents}
                        />
                      </td>
                      {canViewCost ? (
                        <td className="px-3 py-3 tabular-nums">
                          {row.hasUnknownCost || row.estimatedCurrentCost == null ? (
                            <span
                              className="cursor-help"
                              title="Невозможно рассчитать: нет полной закупочной стоимости состава"
                            >
                              —
                            </span>
                          ) : (
                            `${row.estimatedCurrentCost} BYN`
                          )}
                        </td>
                      ) : null}
                      <td className="px-3 py-3 tabular-nums">{row.salePrice} BYN</td>
                      {canViewCost ? (
                        <td className="px-3 py-3 tabular-nums">
                          {row.estimatedMargin != null ? (
                            <span title="Расчёт по текущей стоимости складского остатка. Фактическая себестоимость заказа может отличаться.">
                              {row.estimatedMargin} BYN
                              {row.estimatedMarginPercent != null
                                ? ` (${row.estimatedMarginPercent}%)`
                                : ''}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      ) : null}
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                            row.isActive
                              ? 'bg-success-soft text-success-fg'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {row.isActive ? 'Активен' : 'Неактивен'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/app/bouquets/${row.id}`}
                          className="text-sm font-medium underline-offset-4 hover:underline"
                        >
                          Открыть
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 p-3 md:hidden">
              {items.map((row) => (
                <Link
                  key={row.id}
                  href={`/app/bouquets/${row.id}`}
                  className="block rounded-2xl border border-border/80 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 font-medium">{row.name}</p>
                    <span
                      className={cn(
                        'shrink-0 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                        row.isActive
                          ? 'bg-success-soft text-success-fg'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {row.isActive ? 'Активен' : 'Неактивен'}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    <StatRow label="Цена продажи" value={`${row.salePrice} BYN`} emphasize />
                    {canViewCost ? (
                      <StatRow
                        label="Себестоимость"
                        value={
                          row.hasUnknownCost || row.estimatedCurrentCost == null
                            ? '—'
                            : `${row.estimatedCurrentCost} BYN`
                        }
                      />
                    ) : null}
                    <div className="pt-1">
                      <AvailabilityBadge
                        count={row.availableBouquets}
                        inactive={row.hasInactiveComponents}
                      />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>

      {total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Всего: {total} · стр. {page}/{totalPages}
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
              Далее
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AvailabilityBadge({
  count,
  inactive,
}: {
  count: number;
  inactive: boolean;
}): ReactElement {
  if (inactive || count === 0) {
    return (
      <span className="inline-flex rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger-fg">
        Нет полного состава
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-fg">
      Можно собрать: {count}
    </span>
  );
}
