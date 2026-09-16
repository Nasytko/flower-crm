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
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,#fff8ef,transparent_45%),linear-gradient(180deg,#f4f1eb,#ebe6de)] px-4 py-10 sm:px-6 sm:py-16">
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,#fff8ef,transparent_45%),linear-gradient(180deg,#f4f1eb,#ebe6de)] px-4 py-10 sm:px-6 sm:py-16">
      <LoginForm />
    </main>
  );
}
