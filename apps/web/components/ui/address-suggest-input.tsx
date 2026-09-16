'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import {
  ApiAddressProvider,
  type AddressSuggestion,
} from '@/lib/address/address-suggestion-provider';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const provider = new ApiAddressProvider();

export type AddressSuggestValue = {
  addressText: string;
  latitude: number | null;
  longitude: number | null;
  provider: string | null;
  providerPlaceId: string | null;
};

export function AddressSuggestInput({
  id,
  value,
  disabled,
  onChange,
  placeholder,
  className,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: AddressSuggestValue;
  disabled?: boolean;
  onChange: (next: AddressSuggestValue) => void;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}): ReactElement {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const requestSeq = useRef(0);

  const query = value.addressText.trim();
  const queryActive = !disabled && query.length >= 2;
  const visibleSuggestions = queryActive ? suggestions : [];
  const visibleLoading = queryActive && loading;

  useEffect(() => {
    if (!queryActive) {
      return;
    }

    const seq = ++requestSeq.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setSuggestions([]);
      void provider
        .suggest({ query, limit: 6 })
        .then((items) => {
          if (seq !== requestSeq.current) return;
          setSuggestions(items);
          setHighlight(items.length > 0 ? 0 : -1);
          setLoading(false);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setSuggestions([]);
          setLoading(false);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [query, queryActive]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const selectSuggestion = (item: AddressSuggestion) => {
    onChange({
      addressText: item.addressText,
      latitude: item.latitude,
      longitude: item.longitude,
      provider: item.provider,
      providerPlaceId: item.providerPlaceId,
    });
    setOpen(false);
    setSuggestions([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || visibleSuggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((prev) => (prev + 1) % visibleSuggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((prev) => (prev <= 0 ? visibleSuggestions.length - 1 : prev - 1));
    } else if (event.key === 'Enter' && highlight >= 0 && visibleSuggestions[highlight]) {
      event.preventDefault();
      selectSuggestion(visibleSuggestions[highlight]!);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Input
        id={id}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        role="combobox"
        disabled={disabled}
        placeholder={placeholder}
        value={value.addressText}
        maxLength={500}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange({
            addressText: e.target.value,
            latitude: null,
            longitude: null,
            provider: null,
            providerPlaceId: null,
          });
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (visibleLoading || visibleSuggestions.length > 0) ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-60 w-full overflow-auto rounded-2xl border border-border bg-card py-1 shadow-lg"
        >
          {visibleLoading && visibleSuggestions.length === 0 ? (
            <li className="px-4 py-2.5 text-sm text-muted-foreground">Поиск…</li>
          ) : null}
          {visibleSuggestions.map((item, index) => (
            <li key={`${item.provider}-${item.providerPlaceId ?? item.label}-${index}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={cn(
                  'flex w-full px-4 py-2.5 text-left text-sm transition-colors',
                  index === highlight ? 'bg-muted' : 'hover:bg-muted/60',
                )}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => selectSuggestion(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
