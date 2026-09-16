'use client';

import { useMemo, type ReactElement } from 'react';
import { PRODUCT_TYPE_LABELS_RU, ProductType, type ProductListItem } from '@erp/shared';
import {
  SearchableSelect,
  type SelectOption,
  type SelectOptionBadge,
} from '@/components/ui/searchable-select';

export function ProductPicker({
  products,
  value,
  onChange,
  disabled = false,
  placeholder = 'Выберите товар…',
  searchPlaceholder = 'Поиск по названию или SKU…',
  reservedIds,
  reservedLabel = 'уже выбрано',
  showStock = true,
  className,
  ariaLabel,
}: {
  products: ProductListItem[];
  value: string;
  onChange: (productId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Product ids already used on other lines (current line value is excluded). */
  reservedIds?: Iterable<string>;
  reservedLabel?: string;
  showStock?: boolean;
  className?: string;
  ariaLabel?: string;
}): ReactElement {
  const reserved = useMemo(() => new Set(reservedIds ?? []), [reservedIds]);

  const options = useMemo<SelectOption[]>(() => {
    const sorted = [...products].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === ProductType.FLOWER ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'ru');
    });

    return sorted.map((product) => {
      const isReserved = reserved.has(product.id) && product.id !== value;
      const badges: SelectOptionBadge[] = [
        {
          text: PRODUCT_TYPE_LABELS_RU[product.type],
          tone: product.type === ProductType.FLOWER ? 'flower' : 'service',
        },
      ];
      if (isReserved) {
        badges.push({ text: reservedLabel, tone: 'warn' });
      }
      if (!product.isActive) {
        badges.push({ text: 'неактивен', tone: 'muted' });
      }

      const details: string[] = [];
      if (product.sku) details.push(product.sku);
      if (showStock && product.type === ProductType.FLOWER) {
        details.push(`На складе: ${product.stock?.availableQuantity ?? 0}`);
      }
      if (product.type === ProductType.SERVICE) {
        details.push('Услуга · без складского остатка');
      }

      return {
        value: product.id,
        label: product.name,
        description: details.join(' · ') || undefined,
        keywords: `${product.sku ?? ''} ${PRODUCT_TYPE_LABELS_RU[product.type]}`,
        group: product.type === ProductType.FLOWER ? 'Цветы' : 'Услуги',
        disabled: isReserved || (!product.isActive && product.id !== value),
        badges,
      };
    });
  }, [products, reserved, reservedLabel, showStock, value]);

  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText="Нет подходящих товаров"
      className={className}
      ariaLabel={ariaLabel ?? placeholder}
      clearable={false}
    />
  );
}
