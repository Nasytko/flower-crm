'use client';

import { Suspense, useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { OrdersKanbanPage } from '@/components/orders-kanban-page';
import { useAuth } from '@/lib/auth/auth-context';

export default function OrdersRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.ORDERS_VIEW)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.ORDERS_VIEW)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Загрузка...</div>}>
      <OrdersKanbanPage />
    </Suspense>
  );
}
