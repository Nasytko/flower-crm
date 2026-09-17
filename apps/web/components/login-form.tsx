'use client';

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { ApiClientError } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({
  login: z.string().min(2, 'Введите логин или email'),
  password: z.string().min(8, 'Введите пароль'),
});

type FormValues = z.infer<typeof schema>;

export function LoginForm(): ReactElement {
  const router = useRouter();
  const { login } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { login: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values.login, values.password);
      router.replace('/app');
    } catch (error) {
      if (error instanceof ApiClientError && error.body.code === 'INVALID_CREDENTIALS') {
        setFormError('Неверный логин или пароль');
        return;
      }
      setFormError('Сервер недоступен. Попробуйте позже.');
    }
  });

  return (
    <div className="rounded-[28px] border border-white/10 bg-white p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Вход</h1>
        <p className="mt-1 text-sm text-muted-foreground">Логин или email сотрудника</p>
      </div>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="login">Логин или email</Label>
          <Input
            id="login"
            autoComplete="username"
            inputMode="email"
            className="h-12 rounded-2xl"
            {...register('login')}
          />
          {errors.login ? <p className="text-sm text-danger-fg">{errors.login.message}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Пароль</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            className="h-12 rounded-2xl"
            {...register('password')}
          />
          {errors.password ? (
            <p className="text-sm text-danger-fg">{errors.password.message}</p>
          ) : null}
        </div>
        {formError ? (
          <p className="rounded-2xl bg-danger-soft px-3 py-2.5 text-sm text-danger-fg">{formError}</p>
        ) : null}
        <Button
          className="mt-2 h-12 w-full rounded-2xl text-base font-semibold"
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Вход…' : 'Войти'}
        </Button>
      </form>
    </div>
  );
}
