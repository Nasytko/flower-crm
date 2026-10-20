'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProductAttrKind, ProductAttributeValueDto } from '@erp/shared';
import { listProductAttributes } from '@/lib/api/product-attributes';
import { SearchableSelect, type SelectOption } from '@/components/ui/searchable-select';

export type AttrSelection =
  | { mode: 'existing'; id: string; name: string }
  | { mode: 'draft'; draftKey: string; name: string }
  | null;

function draftKey(kind: ProductAttrKind, name: string, parentId: string | null): string {
  return `draft:${kind}:${parentId ?? ''}:${name.trim().toLocaleLowerCase('ru-RU')}`;
}

export function CreatableAttrSelect({
  kind,
  parentId,
  value,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
  dependsOnParent = false,
  parentMissingText = 'Сначала выберите вид цветка',
}: {
  kind: ProductAttrKind;
  parentId?: string | null;
  value: AttrSelection;
  onChange: (next: AttrSelection) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  dependsOnParent?: boolean;
  parentMissingText?: string;
}): ReactElement {
  const parentReady = !dependsOnParent || Boolean(parentId && !parentId.startsWith('draft:'));
  const parentIsDraft = Boolean(dependsOnParent && parentId?.startsWith('draft:'));
  const [localDrafts, setLocalDrafts] = useState<ProductAttributeValueDto[]>([]);

  const query = useQuery({
    queryKey: ['product-attributes', kind, parentId ?? ''],
    queryFn: () =>
      listProductAttributes({
        kind,
        parentId: parentReady ? (parentId ?? undefined) : undefined,
        limit: 200,
      }),
    enabled: !dependsOnParent || parentReady,
  });

  const options = useMemo<SelectOption[]>(() => {
    const server = query.data ?? [];
    const merged = new Map<string, ProductAttributeValueDto>();
    for (const row of server) merged.set(row.id, row);
    for (const row of localDrafts) {
      if (!dependsOnParent || row.parentId === parentId || row.parentKey === (parentId ?? '')) {
        merged.set(row.id, row);
      }
    }
    if (value?.mode === 'draft') {
      merged.set(value.draftKey, {
        id: value.draftKey,
        kind,
        name: value.name,
        parentId: parentId ?? null,
        parentKey: parentId ?? '',
      });
    }
    if (value?.mode === 'existing' && !merged.has(value.id)) {
      merged.set(value.id, {
        id: value.id,
        kind,
        name: value.name,
        parentId: parentId ?? null,
        parentKey: parentId ?? '',
      });
    }
    return [...merged.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      .map((row) => ({ value: row.id, label: row.name }));
  }, [query.data, localDrafts, value, kind, parentId, dependsOnParent]);

  const selectValue =
    value?.mode === 'existing' ? value.id : value?.mode === 'draft' ? value.draftKey : '';

  if (dependsOnParent && !parentId) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-3.5 py-3 text-sm text-muted-foreground">
        {parentMissingText}
      </p>
    );
  }

  return (
    <SearchableSelect
      value={selectValue}
      onChange={(next) => {
        if (!next) {
          onChange(null);
          return;
        }
        if (next.startsWith('draft:')) {
          const draft = localDrafts.find((d) => d.id === next);
          onChange({
            mode: 'draft',
            draftKey: next,
            name: draft?.name ?? value?.name ?? next,
          });
          return;
        }
        const opt = options.find((o) => o.value === next);
        onChange({ mode: 'existing', id: next, name: opt?.label ?? next });
      }}
      options={options}
      disabled={disabled || (dependsOnParent && parentIsDraft && false)}
      placeholder={placeholder ?? 'Выберите…'}
      clearable
      creatable
      ariaLabel={ariaLabel}
      onCreate={(label) => {
        const key = draftKey(kind, label, parentId ?? null);
        const row: ProductAttributeValueDto = {
          id: key,
          kind,
          name: label.trim().replace(/\s+/g, ' '),
          parentId: parentId ?? null,
          parentKey: parentId ?? '',
        };
        setLocalDrafts((prev) => (prev.some((p) => p.id === key) ? prev : [...prev, row]));
        onChange({ mode: 'draft', draftKey: key, name: row.name });
      }}
      emptyText={query.isLoading ? 'Загрузка…' : 'Ничего не найдено'}
    />
  );
}

export function attrSelectionToRef(value: AttrSelection): { id?: string; name?: string } | null {
  if (!value) return null;
  if (value.mode === 'existing') return { id: value.id };
  return { name: value.name };
}

export function attrSelectionFromProduct(
  id: string | null | undefined,
  name: string | null | undefined,
): AttrSelection {
  if (!id || !name) return null;
  return { mode: 'existing', id, name };
}
