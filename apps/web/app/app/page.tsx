import type { ReactElement } from 'react';
import Link from 'next/link';

const MODULES = [
  {
    href: '/app/orders',
    title: 'Заказы',
    description: 'Kanban по дате исполнения, резервы и статусы',
  },
  {
    href: '/app/warehouse',
    title: 'Склад',
    description: 'Номенклатура, остатки, резерв и списания',
  },
  {
    href: '/app/supplies',
    title: 'Поставки',
    description: 'Приход цветов и партии FIFO',
  },
  {
    href: '/app/inventories',
    title: 'Инвентаризация',
    description: 'Сверка факта со снимком, заморозка склада',
  },
  {
    href: '/app/bouquets',
    title: 'Букеты',
    description: 'Рецепты состава без отдельного остатка',
  },
] as const;

export default function AppHomePage(): ReactElement {
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Главная</h1>
        <p className="text-muted-foreground">
          Внутренний ERP цветочного магазина: заказы со складскими резервами, склад, поставки,
          инвентаризация и букеты-рецепты. Платежи, CRM и публичный API сайта — следующие этапы.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {MODULES.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="block min-h-[5.5rem] rounded-[24px] border border-border bg-card px-5 py-4 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
            >
              <div className="font-semibold text-foreground">{item.title}</div>
              <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
