'use client';

import { useEffect, type ReactElement } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Permission } from '@erp/shared';
import { InventoryDetailPage } from '@/components/inventory-detail-page';
import { useAuth } from '@/lib/auth/auth-context';

export default function InventoryDetailRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.INVENTORY_VIEW)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  if (!bootstrapped || !user || !hasPermission(Permission.INVENTORY_VIEW) || !id) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  return <InventoryDetailPage inventoryId={id} />;
}
