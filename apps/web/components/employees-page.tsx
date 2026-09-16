'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Permission,
  Role,
  ROLE_LABELS_RU,
  formatBrowserLabel,
  type EmployeeListItem,
} from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import {
  createEmployee,
  deactivateEmployee,
  listEmployees,
  resetEmployeePassword,
  updateEmployee,
} from '@/lib/api/employees';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { StatRow } from '@/components/ui/stat-row';
import { userFacingError } from '@/lib/api/error-messages';
import { cn } from '@/lib/utils';

const createSchema = z
  .object({
    name: z.string().min(2),
    login: z
      .string()
      .min(2)
      .regex(/^[a-zA-Z0-9._-]+$/),
    email: z.string().trim().email('Некорректный email').or(z.literal('')).optional(),
    role: z.nativeEnum(Role),
    password: z.string().min(8),
    confirmPassword: z.string().min(8),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Пароли не совпадают',
    path: ['confirmPassword'],
  });

type CreateValues = z.infer<typeof createSchema>;

function sessionLabel(employee: EmployeeListItem): string {
  if (!employee.hasActiveSession) return 'Нет';
  if (employee.activeSessionCount <= 1) return 'Да';
  return `Да · ${employee.activeSessionCount}`;
}

export function EmployeesPage(): ReactElement {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.EMPLOYEES_MANAGE);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<EmployeeListItem | null>(null);
  const [resetTarget, setResetTarget] = useState<EmployeeListItem | null>(null);

  const employeesQuery = useQuery({
    queryKey: queryKeys.employees,
    queryFn: listEmployees,
  });

  const createForm = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      login: '',
      email: '',
      role: Role.FLORIST,
      password: '',
      confirmPassword: '',
    },
  });

  const createMutation = useMutation({
    mutationFn: createEmployee,
    onSuccess: async () => {
      createForm.reset({
        name: '',
        login: '',
        email: '',
        role: Role.FLORIST,
        password: '',
        confirmPassword: '',
      });
      setMessage('Сотрудник создан');
      await queryClient.invalidateQueries({ queryKey: queryKeys.employees });
    },
    onError: (error) => {
      setMessage(userFacingError(error, 'Ошибка создания'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateEmployee>[1] }) =>
      updateEmployee(id, data),
    onSuccess: async () => {
      setEditing(null);
      setMessage('Данные обновлены');
      await queryClient.invalidateQueries({ queryKey: queryKeys.employees });
    },
    onError: (error) => {
      setMessage(userFacingError(error, 'Ошибка обновления'));
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: deactivateEmployee,
    onSuccess: async () => {
      setMessage('Сотрудник деактивирован');
      await queryClient.invalidateQueries({ queryKey: queryKeys.employees });
    },
    onError: (error) => {
      setMessage(userFacingError(error, 'Ошибка деактивации'));
    },
  });

  const resetMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      resetEmployeePassword(id, password),
    onSuccess: async () => {
      setResetTarget(null);
      setMessage('Пароль обновлён, сессии сотрудника отозваны');
      await queryClient.invalidateQueries({ queryKey: queryKeys.employees });
    },
    onError: (error) => {
      setMessage(userFacingError(error, 'Ошибка сброса пароля'));
    },
  });

  const rows = useMemo(() => employeesQuery.data ?? [], [employeesQuery.data]);
  const activeSessions = useMemo(() => rows.filter((row) => row.hasActiveSession).length, [rows]);
  const anyMutationPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    deactivateMutation.isPending ||
    resetMutation.isPending;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Сотрудники"
        description="Учётные записи и роли магазина"
        actions={
          canManage ? (
            <Button
              type="button"
              className="min-h-10 w-full sm:w-auto"
              onClick={() => {
                document.getElementById('employee-create')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              + Сотрудник
            </Button>
          ) : null
        }
      />

      {message ? <p className="text-sm text-emerald-800">{message}</p> : null}

      {!employeesQuery.isLoading && !employeesQuery.isError && rows.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Всего</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{rows.length}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Активны</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {rows.filter((row) => row.isActive).length}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Онлайн</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{activeSessions}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">С email</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {rows.filter((row) => Boolean(row.email)).length}
            </p>
          </div>
        </div>
      ) : null}

      {canManage ? (
        <section
          id="employee-create"
          className="rounded-[24px] border border-border bg-card p-4 sm:p-5"
        >
          <h2 className="mb-3 text-base font-semibold">Новый сотрудник</h2>
          <form
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
            onSubmit={createForm.handleSubmit((values) =>
              createMutation.mutate({
                name: values.name,
                login: values.login,
                email: values.email?.trim() ? values.email.trim() : null,
                role: values.role,
                password: values.password,
              }),
            )}
          >
            <div className="space-y-2">
              <Label>Имя</Label>
              <Input {...createForm.register('name')} disabled={anyMutationPending} />
            </div>
            <div className="space-y-2">
              <Label>Логин</Label>
              <Input {...createForm.register('login')} disabled={anyMutationPending} />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                placeholder="необязательно"
                {...createForm.register('email')}
                disabled={anyMutationPending}
              />
              {createForm.formState.errors.email ? (
                <p className="text-sm text-danger-fg">
                  {createForm.formState.errors.email.message}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>Роль</Label>
              <Controller
                control={createForm.control}
                name="role"
                render={({ field }) => (
                  <SearchableSelect
                    ariaLabel="Роль"
                    value={field.value}
                    searchable={false}
                    disabled={anyMutationPending}
                    onChange={(next) => field.onChange(next as Role)}
                    options={Object.values(Role).map((role) => ({
                      value: role,
                      label: ROLE_LABELS_RU[role],
                    }))}
                  />
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>Пароль</Label>
              <Input
                type="password"
                {...createForm.register('password')}
                disabled={anyMutationPending}
              />
            </div>
            <div className="space-y-2">
              <Label>Подтверждение пароля</Label>
              <Input
                type="password"
                {...createForm.register('confirmPassword')}
                disabled={anyMutationPending}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                className="min-h-11 w-full md:w-auto"
                disabled={createMutation.isPending || anyMutationPending}
              >
                Создать
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[28px] border border-border bg-card">
        {employeesQuery.isLoading ? (
          <div className="p-8 text-sm text-muted-foreground">Загрузка сотрудников...</div>
        ) : employeesQuery.isError ? (
          <div className="space-y-3 p-8 text-sm">
            <p className="text-danger-fg">
              {userFacingError(employeesQuery.error, 'Не удалось загрузить сотрудников')}
            </p>
            <Button type="button" variant="outline" onClick={() => void employeesQuery.refetch()}>
              Повторить
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">Сотрудников пока нет</div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 font-medium">Имя</th>
                    <th className="px-4 py-3 font-medium">Логин</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Роль</th>
                    <th className="px-4 py-3 font-medium">Статус</th>
                    <th className="px-4 py-3 font-medium">Сессия</th>
                    <th className="px-4 py-3 font-medium">Последний вход</th>
                    <th className="px-4 py-3 font-medium">Браузер</th>
                    {canManage ? <th className="px-4 py-3 font-medium">Действия</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((employee) => (
                    <tr key={employee.id} className="border-b border-border/70">
                      <td className="px-4 py-3">{employee.name}</td>
                      <td className="px-4 py-3">{employee.login}</td>
                      <td className="px-4 py-3">{employee.email ?? '—'}</td>
                      <td className="px-4 py-3">{ROLE_LABELS_RU[employee.role]}</td>
                      <td className="px-4 py-3">{employee.isActive ? 'Активен' : 'Отключён'}</td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                            employee.hasActiveSession
                              ? 'bg-success-soft text-success-fg'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {sessionLabel(employee)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {employee.lastLoginAt
                          ? new Date(employee.lastLoginAt).toLocaleString('ru-RU')
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {formatBrowserLabel(employee.lastLoginUserAgent)}
                      </td>
                      {canManage ? (
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={anyMutationPending}
                              onClick={() => setEditing(employee)}
                            >
                              Изменить
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={anyMutationPending}
                              onClick={() => setResetTarget(employee)}
                            >
                              Пароль
                            </Button>
                            {employee.isActive ? (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={anyMutationPending}
                                onClick={() => deactivateMutation.mutate(employee.id)}
                              >
                                Отключить
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 p-3 md:hidden">
              {rows.map((employee) => (
                <div key={employee.id} className="rounded-2xl border border-border/80 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{employee.name}</p>
                    <span
                      className={cn(
                        'shrink-0 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                        employee.isActive
                          ? 'bg-success-soft text-success-fg'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {employee.isActive ? 'Активен' : 'Отключён'}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    <StatRow label="Логин" value={employee.login} />
                    <StatRow label="Email" value={employee.email ?? '—'} />
                    <StatRow label="Роль" value={ROLE_LABELS_RU[employee.role]} />
                    <StatRow label="Сессия" value={sessionLabel(employee)} />
                    <StatRow
                      label="Вход"
                      value={
                        employee.lastLoginAt
                          ? new Date(employee.lastLoginAt).toLocaleString('ru-RU')
                          : '—'
                      }
                    />
                    <StatRow
                      label="Браузер"
                      value={formatBrowserLabel(employee.lastLoginUserAgent)}
                    />
                  </div>
                  {canManage ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-10 w-full"
                        disabled={anyMutationPending}
                        onClick={() => setEditing(employee)}
                      >
                        Изменить
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-10 w-full"
                        disabled={anyMutationPending}
                        onClick={() => setResetTarget(employee)}
                      >
                        Пароль
                      </Button>
                      {employee.isActive ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="min-h-10 w-full"
                          disabled={anyMutationPending}
                          onClick={() => deactivateMutation.mutate(employee.id)}
                        >
                          Отключить
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {editing ? (
        <EditEmployeeDialog
          employee={editing}
          pending={updateMutation.isPending}
          onClose={() => setEditing(null)}
          onSave={(data) => updateMutation.mutate({ id: editing.id, data })}
        />
      ) : null}

      {resetTarget ? (
        <ResetPasswordDialog
          employee={resetTarget}
          pending={resetMutation.isPending}
          onClose={() => setResetTarget(null)}
          onSave={(password) => resetMutation.mutate({ id: resetTarget.id, password })}
        />
      ) : null}
    </div>
  );
}

function EditEmployeeDialog({
  employee,
  onClose,
  onSave,
  pending,
}: {
  employee: EmployeeListItem;
  onClose: () => void;
  onSave: (data: {
    name: string;
    login: string;
    email: string | null;
    role: Role;
    isActive: boolean;
  }) => void;
  pending: boolean;
}): ReactElement {
  const [name, setName] = useState(employee.name);
  const [login, setLogin] = useState(employee.login);
  const [email, setEmail] = useState(employee.email ?? '');
  const [role, setRole] = useState(employee.role);
  const [isActive, setIsActive] = useState(employee.isActive);

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title="Редактирование"
      size="sheet"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              onSave({
                name,
                login,
                email: email.trim() ? email.trim() : null,
                role,
                isActive,
              })
            }
          >
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="edit-emp-name">Имя</Label>
          <Input
            id="edit-emp-name"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-emp-login">Логин</Label>
          <Input
            id="edit-emp-login"
            value={login}
            disabled={pending}
            onChange={(event) => setLogin(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-emp-email">Email</Label>
          <Input
            id="edit-emp-email"
            type="email"
            value={email}
            disabled={pending}
            placeholder="необязательно"
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Роль</Label>
          <SearchableSelect
            ariaLabel="Роль сотрудника"
            value={role}
            searchable={false}
            disabled={pending}
            onChange={(next) => setRole(next as Role)}
            options={Object.values(Role).map((item) => ({
              value: item,
              label: ROLE_LABELS_RU[item],
            }))}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            disabled={pending}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          Активен
        </label>
      </div>
    </ResponsiveDialog>
  );
}

function ResetPasswordDialog({
  employee,
  onClose,
  onSave,
  pending,
}: {
  employee: EmployeeListItem;
  onClose: () => void;
  onSave: (password: string) => void;
  pending: boolean;
}): ReactElement {
  const [password, setPassword] = useState('');

  return (
    <ResponsiveDialog
      open
      onClose={onClose}
      title={`Новый пароль для ${employee.name}`}
      size="sm"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={pending || password.length < 8} onClick={() => onSave(password)}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="reset-emp-password">Пароль</Label>
        <Input
          id="reset-emp-password"
          type="password"
          value={password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
    </ResponsiveDialog>
  );
}
