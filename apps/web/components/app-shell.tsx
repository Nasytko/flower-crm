'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { Permission, ROLE_LABELS_RU } from '@erp/shared';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; icon: string };

function navActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/app' && pathname.startsWith(`${href}/`));
}

function sectionTitle(pathname: string, items: NavItem[]): string {
  const match = items.find((item) => navActive(pathname, item.href));
  return match?.label ?? 'Цветок CRM';
}

export function AppShell({ children }: { children: ReactNode }): ReactElement {
  const { user, bootstrapped, logout, hasPermission } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPathname, setDrawerPathname] = useState(pathname);
  const drawerTitleId = useId();

  // Close drawer when the route changes (back/forward or programmatic nav).
  if (drawerPathname !== pathname) {
    setDrawerPathname(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  useEffect(() => {
    if (bootstrapped && !user) {
      router.replace('/login');
    }
  }, [bootstrapped, user, router]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  if (!bootstrapped || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Загрузка...
      </div>
    );
  }

  const items: NavItem[] = [
    { href: '/app', label: 'Главная', icon: '⌂' },
    ...(hasPermission(Permission.ORDERS_VIEW)
      ? [{ href: '/app/orders', label: 'Заказы', icon: '☰' }]
      : []),
    ...(hasPermission(Permission.PRODUCTS_VIEW)
      ? [{ href: '/app/warehouse', label: 'Склад', icon: '▣' }]
      : []),
    ...(hasPermission(Permission.SUPPLIES_VIEW)
      ? [{ href: '/app/supplies', label: 'Поставки', icon: '▤' }]
      : []),
    ...(hasPermission(Permission.INVENTORY_VIEW)
      ? [{ href: '/app/inventories', label: 'Инвентаризация', icon: '☑' }]
      : []),
    ...(hasPermission(Permission.BOUQUETS_VIEW)
      ? [{ href: '/app/bouquets', label: 'Букеты', icon: '❀' }]
      : []),
    ...(hasPermission(Permission.EMPLOYEES_VIEW)
      ? [{ href: '/app/employees', label: 'Сотрудники', icon: '☺' }]
      : []),
  ];

  const initial = user.name.trim().charAt(0).toUpperCase() || 'U';
  const title = sectionTitle(pathname, items);

  const navLinks = (
    <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Основная навигация">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setDrawerOpen(false)}
          className={cn(
            'flex min-h-11 items-center gap-3 rounded-2xl px-3 py-2.5 text-sm transition-colors',
            navActive(pathname, item.href)
              ? 'bg-sidebar-active font-semibold text-sidebar-active-foreground'
              : 'text-sidebar-foreground/85 hover:bg-white/5 hover:text-white focus-visible:bg-white/5 focus-visible:text-white',
          )}
        >
          <span className="w-5 text-center text-base opacity-80" aria-hidden>
            {item.icon}
          </span>
          {item.label}
        </Link>
      ))}
    </nav>
  );

  const userBlock = (
    <div className="mt-auto border-t border-white/8 p-4">
      <div className="mb-3 flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{user.name}</p>
          <p className="truncate text-xs text-sidebar-muted">{ROLE_LABELS_RU[user.role]}</p>
        </div>
      </div>
      <Button
        variant="soft"
        className="h-11 w-full rounded-xl bg-white/8 text-sidebar-foreground hover:bg-white/12"
        onClick={() => {
          void logout().then(() => router.replace('/login'));
        }}
      >
        Выйти
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop / large tablet permanent sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground"
            aria-hidden
          >
            ✿
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight text-white">Цветок CRM</p>
            <p className="text-[11px] text-sidebar-muted">цветочный магазин</p>
          </div>
        </div>
        {navLinks}
        {userBlock}
      </aside>

      {/* Mobile / tablet drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Закрыть меню"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby={drawerTitleId}
            className="absolute inset-y-0 left-0 flex w-[min(100%,288px)] flex-col bg-sidebar text-sidebar-foreground shadow-xl"
          >
            <div className="flex items-center justify-between gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground"
                  aria-hidden
                >
                  ✿
                </span>
                <p id={drawerTitleId} className="text-sm font-semibold text-white">
                  Цветок CRM
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/10"
                aria-label="Закрыть меню"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-5" />
              </Button>
            </div>
            {navLinks}
            {userBlock}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:hidden pt-[max(0.5rem,env(safe-area-inset-top))]">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label="Открыть меню"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">{title}</p>
            <p className="truncate text-xs text-muted-foreground">{ROLE_LABELS_RU[user.role]}</p>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-3 py-4 sm:px-5 sm:py-6 md:px-6 md:py-7 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
