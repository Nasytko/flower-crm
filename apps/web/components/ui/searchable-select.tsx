'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SelectBadgeTone =
  'neutral' | 'primary' | 'warn' | 'success' | 'muted' | 'flower' | 'service';

export interface SelectOptionBadge {
  text: string;
  tone?: SelectBadgeTone;
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
  disabled?: boolean;
  badges?: SelectOptionBadge[];
  group?: string;
}

const BADGE_TONES: Record<SelectBadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  primary: 'bg-primary-soft text-foreground',
  warn: 'bg-warn-soft text-warn-fg',
  success: 'bg-success-soft text-success-fg',
  muted: 'bg-muted text-muted-foreground',
  flower: 'bg-type-flower-bg text-type-flower-fg',
  service: 'bg-type-service-bg text-type-service-fg',
};

export function OptionBadge({ text, tone = 'neutral' }: SelectOptionBadge): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none',
        BADGE_TONES[tone],
      )}
    >
      {text}
    </span>
  );
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Выберите…',
  searchPlaceholder = 'Поиск…',
  emptyText = 'Ничего не найдено',
  disabled = false,
  searchable = true,
  clearable = false,
  className,
  triggerClassName,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  searchable?: boolean;
  clearable?: boolean;
  className?: string;
  triggerClassName?: string;
  ariaLabel?: string;
}): ReactElement {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => {
      const haystack =
        `${option.label} ${option.description ?? ''} ${option.keywords ?? ''} ${option.group ?? ''}`
          .toLowerCase()
          .trim();
      return haystack.includes(q);
    });
  }, [options, query]);

  const groups = useMemo(() => {
    const map = new Map<string | null, SelectOption[]>();
    for (const option of filtered) {
      const key = option.group ?? null;
      const list = map.get(key) ?? [];
      list.push(option);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const flatEnabled = useMemo(() => filtered.filter((option) => !option.disabled), [filtered]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHighlight(0);
  }, []);

  const updatePanelPosition = useCallback(() => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 280);
    const maxHeight = 320;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const openUp = spaceBelow < 220 && rect.top > spaceBelow;
    const top = openUp
      ? Math.max(8, rect.top - Math.min(maxHeight, rect.top - 8) - 8)
      : rect.bottom + 8;
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    setPanelStyle({
      position: 'fixed',
      top,
      left: Math.max(8, left),
      width,
      maxHeight,
      zIndex: 80,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
    const onScroll = () => updatePanelPosition();
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, updatePanelPosition, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || !searchable) return;
    queueMicrotask(() => searchRef.current?.focus());
  }, [open, searchable]);

  const pick = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  };

  const openPanel = () => {
    setQuery('');
    setHighlight(0);
    setOpen(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPanel();
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, Math.max(flatEnabled.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = flatEnabled[highlight];
      if (option) pick(option);
    }
  };

  let enabledIndex = -1;

  const panel =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={panelRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            style={panelStyle}
            onKeyDown={onListKeyDown}
            className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgba(15,23,42,0.14)]"
          >
            {searchable ? (
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="size-4 text-muted-foreground" aria-hidden />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlight(0);
                  }}
                  placeholder={searchPlaceholder}
                  className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            ) : null}

            <div className="max-h-72 overflow-y-auto p-1.5">
              {clearable && value ? (
                <button
                  type="button"
                  className="mb-1 flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
                  onClick={() => {
                    onChange('');
                    close();
                  }}
                >
                  Очистить выбор
                </button>
              ) : null}

              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
              ) : (
                groups.map(([group, groupOptions]) => (
                  <div key={group ?? '__ungrouped'} className="mb-1">
                    {group ? (
                      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        {group}
                      </div>
                    ) : null}
                    {groupOptions.map((option) => {
                      if (!option.disabled) enabledIndex += 1;
                      const index = enabledIndex;
                      const isSelected = option.value === value;
                      const isHighlighted = !option.disabled && index === highlight;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          disabled={option.disabled}
                          onMouseEnter={() => {
                            if (!option.disabled) setHighlight(index);
                          }}
                          onClick={() => pick(option)}
                          className={cn(
                            'flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition-colors',
                            option.disabled
                              ? 'cursor-not-allowed opacity-45'
                              : isHighlighted
                                ? 'bg-primary-soft'
                                : 'hover:bg-muted/70',
                            isSelected && !option.disabled && 'bg-muted',
                          )}
                        >
                          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                            {isSelected ? <Check className="size-4" aria-hidden /> : null}
                          </span>
                          <span className="min-w-0 flex-1 space-y-1">
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{option.label}</span>
                              {option.badges?.map((badge) => (
                                <OptionBadge key={`${option.value}-${badge.text}`} {...badge} />
                              ))}
                            </span>
                            {option.description ? (
                              <span className="block text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-card px-3 text-left text-sm transition-colors',
          'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-45',
          open && 'ring-2 ring-ring',
          triggerClassName,
        )}
      >
        <span className="min-w-0 flex-1">
          {selected ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{selected.label}</span>
              {selected.badges
                ?.filter((badge) => badge.tone === 'flower' || badge.tone === 'service')
                .slice(0, 1)
                .map((badge) => (
                  <OptionBadge key={badge.text} {...badge} />
                ))}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {panel}
    </div>
  );
}

export function FilterSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  className?: string;
}): ReactElement {
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={options}
      searchable={false}
      ariaLabel={ariaLabel}
      className={className}
      triggerClassName="h-11 rounded-full px-4"
      placeholder="Выберите…"
    />
  );
}

export function FieldHint({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
