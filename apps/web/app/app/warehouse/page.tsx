'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { WarehousePage } from '@/components/warehouse-page';
import { useAuth } from '@/lib/auth/auth-context';

export default function WarehouseRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.PRODUCTS_VIEW)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.PRODUCTS_VIEW)) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return <WarehousePage />;
}
