'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { useAuth } from '@/lib/auth/auth-context';

export default function LoginPage(): ReactElement {
  const { user, bootstrapped } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user) {
      router.replace('/app');
    }
  }, [bootstrapped, user, router]);

  if (!bootstrapped || user) {
    return (
      <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#0e0f12] px-4 py-10">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(200,240,0,0.18),transparent_50%),radial-gradient(ellipse_at_90%_80%,rgba(200,240,0,0.08),transparent_45%)]"
          aria-hidden
        />
        <p className="relative text-sm text-white/60">Загрузка...</p>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#0e0f12] px-4 py-10 sm:px-6 sm:py-16">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(200,240,0,0.22),transparent_52%),radial-gradient(ellipse_at_100%_100%,rgba(200,240,0,0.1),transparent_48%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-24 top-1/4 size-72 rounded-full bg-primary/10 blur-3xl"
        aria-hidden
      />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center sm:mb-10">
          <span
            className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-2xl font-bold text-primary-foreground shadow-[0_12px_40px_rgba(200,240,0,0.35)]"
            aria-hidden
          >
            ✿
          </span>
          <p className="text-2xl font-semibold tracking-tight text-white sm:text-[1.75rem]">
            Цветок CRM
          </p>
          <p className="mt-1.5 text-sm text-white/55">Внутренняя система цветочного магазина</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
