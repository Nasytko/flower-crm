'use client';

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { ApiClientError } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    <Card className="w-full max-w-md border-border/80">
      <CardHeader>
        <CardTitle>Цветок CRM</CardTitle>
        <CardDescription>Вход для сотрудников цветочного магазина</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="login">Логин или email</Label>
            <Input id="login" autoComplete="username" {...register('login')} />
            {errors.login ? <p className="text-sm text-red-700">{errors.login.message}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-sm text-red-700">{errors.password.message}</p>
            ) : null}
          </div>
          {formError ? <p className="text-sm text-red-700">{formError}</p> : null}
          <Button className="w-full" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Вход...' : 'Войти'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
