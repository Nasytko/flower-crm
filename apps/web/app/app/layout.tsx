import type { ReactElement, ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

export default function AuthenticatedLayout({ children }: { children: ReactNode }): ReactElement {
  return <AppShell>{children}</AppShell>;
}
