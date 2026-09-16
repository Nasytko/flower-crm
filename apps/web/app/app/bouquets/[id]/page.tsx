'use client';

import { useEffect, type ReactElement } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@erp/shared';
import { BouquetEditor } from '@/components/bouquet-editor';
import { useAuth } from '@/lib/auth/auth-context';
import { getBouquet } from '@/lib/api/bouquets';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';

export default function BouquetDetailRoutePage(): ReactElement {
  const { hasPermission, bootstrapped, user } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  useEffect(() => {
    if (bootstrapped && user && !hasPermission(Permission.BOUQUETS_VIEW)) {
      router.replace('/app');
    }
  }, [bootstrapped, user, hasPermission, router]);

  const query = useQuery({
    queryKey: queryKeys.bouquet(id ?? ''),
    queryFn: () => getBouquet(id!),
    enabled: Boolean(id) && bootstrapped && Boolean(user),
  });

  if (!bootstrapped || !user || !hasPermission(Permission.BOUQUETS_VIEW) || !id) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  if (query.isLoading) {
    return <div className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-danger-fg">Не удалось загрузить букет</p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>
          Повторить
        </Button>
      </div>
    );
  }

  return <BouquetEditor mode="edit" initial={query.data} />;
}
