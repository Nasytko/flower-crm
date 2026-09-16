'use client';

import { useState, type ReactElement } from 'react';
import {
  PHONE_COUNTRIES,
  formatNational,
  getPhoneCountry,
  normalizeNationalInput,
  parseStoredPhone,
  toStoredPhone,
  type PhoneCountryId,
} from '@/lib/phone';
import { cn } from '@/lib/utils';

export function PhoneInput({
  id,
  value,
  onChange,
  disabled,
  required,
  'aria-label': ariaLabel,
  className,
}: {
  id?: string;
  /** Stored international value, e.g. +375291112233 */
  value: string;
  onChange: (stored: string) => void;
  disabled?: boolean;
  required?: boolean;
  'aria-label'?: string;
  className?: string;
}): ReactElement {
  const initial = parseStoredPhone(value);
  const [countryId, setCountryId] = useState<PhoneCountryId>(initial.countryId);
  const [national, setNational] = useState(initial.nationalDigits);
  const [syncedValue, setSyncedValue] = useState(value);

  // Sync from parent when stored value changes externally (load/edit/reset).
  // Empty value must NOT reset the user's country selection.
  if (value !== syncedValue) {
    setSyncedValue(value);
    if (!value.trim()) {
      setNational('');
    } else {
      const parsed = parseStoredPhone(value);
      setCountryId(parsed.countryId);
      setNational(parsed.nationalDigits);
    }
  }

  const country = getPhoneCountry(countryId);
  const display =
    countryId === 'OTHER'
      ? value.trim() || (national ? `+${national}` : '')
      : formatNational(countryId, national);

  const commit = (nextCountry: PhoneCountryId, nextNational: string) => {
    const stored = toStoredPhone(nextCountry, nextNational);
    setCountryId(nextCountry);
    setNational(nextNational);
    setSyncedValue(stored);
    onChange(stored);
  };

  return (
    <div
      className={cn(
        'flex h-11 w-full items-stretch overflow-hidden rounded-full border border-border bg-card focus-within:ring-2 focus-within:ring-ring/40',
        disabled && 'opacity-70',
        className,
      )}
    >
      <label className="sr-only" htmlFor={id ? `${id}-country` : undefined}>
        Код страны
      </label>
      <select
        id={id ? `${id}-country` : undefined}
        disabled={disabled}
        value={countryId}
        aria-label="Код страны"
        onChange={(e) => {
          const nextId = e.target.value as PhoneCountryId;
          const nextNational =
            nextId === 'OTHER' ? national : normalizeNationalInput(nextId, national);
          commit(nextId, nextNational);
        }}
        className="h-full min-w-[6.75rem] max-w-[8.5rem] shrink-0 cursor-pointer appearance-none border-0 border-r border-border bg-muted/50 bg-[length:0.75rem] bg-[right_0.55rem_center] bg-no-repeat py-0 pl-3 pr-7 text-xs font-semibold outline-none disabled:cursor-not-allowed"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3 4.5 3 3 3-3'/%3E%3C/svg%3E\")",
        }}
      >
        {PHONE_COUNTRIES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>

      {countryId !== 'OTHER' && country.dial ? (
        <span
          className="flex items-center border-r border-border bg-muted/20 px-2.5 text-sm font-medium tabular-nums text-muted-foreground"
          aria-hidden
        >
          +{country.dial}
        </span>
      ) : null}

      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required={required}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={country.placeholder}
        value={display}
        onChange={(e) => {
          if (countryId === 'OTHER') {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 15);
            const stored = digits ? `+${digits}` : '';
            setNational(digits);
            setSyncedValue(stored);
            onChange(stored);
            return;
          }
          commit(countryId, normalizeNationalInput(countryId, e.target.value));
        }}
        className="min-w-0 flex-1 border-0 bg-transparent px-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}
