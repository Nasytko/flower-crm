'use client';

import { Suspense, useEffect, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Permission } from '@erp/shared';
import { OrderEditor } from '@/components/order-editor';
import { useAuth } from '@/lib/auth/auth-context';

function NewOrderInner(): ReactElement {
  const searchParams = useSearchParams();
  const date = searchParams.get('date') ?? undefined;
  return <OrderEditor mode="create" defaultDate={date ?? undefined} />;
}

export default function NewOrderRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.ORDERS_CREATE)) {
      router.replace('/app/orders');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.ORDERS_CREATE)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Загрузка...</div>}>
      <NewOrderInner />
    </Suspense>
  );
}
