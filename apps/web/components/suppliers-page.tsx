'use client';

import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission, type SupplierListItem } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { createSupplier, listSuppliers, updateSupplier } from '@/lib/api/suppliers';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { StatRow } from '@/components/ui/stat-row';
import { userFacingError } from '@/lib/api/error-messages';
import { cn } from '@/lib/utils';

export function SuppliersPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.SUPPLIES_CREATE);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SupplierListItem | null>(null);

  const query = useQuery({
    queryKey: queryKeys.suppliers({ page, isActive: 'all' }),
    queryFn: () => listSuppliers({ page, limit: 50, isActive: 'all' }),
  });

  const createMutation = useMutation({
    mutationFn: createSupplier,
    onSuccess: async () => {
      setMessage('Поставщик создан');
      setError(null);
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err) => setError(userFacingError(err, 'Не удалось создать')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof updateSupplier>[1]) =>
      updateSupplier(id, input),
    onSuccess: async () => {
      setMessage('Поставщик обновлён');
      setError(null);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err) => setError(userFacingError(err, 'Не удалось сохранить')),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Поставщики"
        description="Справочник для поставок"
        actions={
          canManage ? (
            <Button type="button" className="min-h-10" onClick={() => setCreateOpen(true)}>
              + Поставщик
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

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        {query.isLoading ? (
          <div className="p-8 text-sm text-muted-foreground">Загрузка...</div>
        ) : query.isError ? (
          <div className="space-y-3 p-8 text-sm">
            <p className="text-danger-fg">Не удалось загрузить поставщиков</p>
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              Повторить
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            Поставщиков пока нет. Добавьте первого.
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Название</th>
                    <th className="px-3 py-3 font-medium">Телефон</th>
                    <th className="px-3 py-3 font-medium">Поставок</th>
                    <th className="px-3 py-3 font-medium">Статус</th>
                    <th className="px-5 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className={cn(
                        'border-b border-border/80 hover:bg-muted/40',
                        !row.isActive && 'opacity-60',
                      )}
                    >
                      <td className="px-5 py-3">
                        <div className="font-medium">{row.name}</div>
                        {row.comment ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">{row.comment}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">{row.phone ?? '—'}</td>
                      <td className="px-3 py-3 tabular-nums">{row.supplyCount}</td>
                      <td className="px-3 py-3">{row.isActive ? 'Активен' : 'Неактивен'}</td>
                      <td className="px-5 py-3 text-right">
                        {canManage ? (
                          <Button type="button" variant="soft" size="sm" onClick={() => setEditing(row)}>
                            Изменить
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 p-3 md:hidden">
              {items.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="block w-full rounded-2xl border border-border/80 px-4 py-3 text-left hover:bg-muted/40"
                  onClick={() => canManage && setEditing(row)}
                >
                  <p className="font-medium">{row.name}</p>
                  <div className="mt-2 space-y-1">
                    <StatRow label="Телефон" value={row.phone ?? '—'} />
                    <StatRow label="Поставок" value={row.supplyCount} />
                    <StatRow label="Статус" value={row.isActive ? 'Активен' : 'Неактивен'} />
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {total > 0 ? (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
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

      {createOpen ? (
        <SupplierFormDialog
          title="Новый поставщик"
          submitLabel="Создать"
          pending={createMutation.isPending}
          onClose={() => setCreateOpen(false)}
          onSubmit={(values) => createMutation.mutate(values)}
        />
      ) : null}

      {editing ? (
        <SupplierFormDialog
          title="Поставщик"
          submitLabel="Сохранить"
          supplier={editing}
          pending={updateMutation.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            updateMutation.mutate({
              id: editing.id,
              ...values,
              isActive: values.isActive,
            })
          }
        />
      ) : null}
    </div>
  );
}

function SupplierFormDialog({
  title,
  submitLabel,
  supplier,
  pending,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  supplier?: SupplierListItem;
  pending: boolean;
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    phone?: string | null;
    comment?: string | null;
    isActive?: boolean;
  }) => void;
}): ReactElement {
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [comment, setComment] = useState(supplier?.comment ?? '');
  const [isActive, setIsActive] = useState(supplier?.isActive ?? true);
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" form="supplier-form" disabled={pending}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <form
        id="supplier-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length < 2) {
            setLocalError('Укажите название');
            return;
          }
          setLocalError(null);
          onSubmit({
            name: name.trim(),
            phone: phone.trim() || null,
            comment: comment.trim() || null,
            ...(supplier ? { isActive } : {}),
          });
        }}
      >
        {localError ? <p className="text-sm text-danger-fg">{localError}</p> : null}
        <div className="space-y-2">
          <Label htmlFor="supplier-name">Название *</Label>
          <Input id="supplier-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="supplier-phone">Телефон</Label>
          <Input id="supplier-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="supplier-comment">Комментарий</Label>
          <Input
            id="supplier-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        {supplier ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl bg-muted/50 px-3 py-2 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-[var(--primary)]"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>Активен</span>
          </label>
        ) : null}
      </form>
    </ResponsiveDialog>
  );
}
