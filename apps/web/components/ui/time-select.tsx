'use client';

import { useMemo, type ReactElement } from 'react';
import { cn } from '@/lib/utils';

const STEP_MINUTES = 5;

function buildSlots(): string[] {
  const slots: string[] = [];
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += STEP_MINUTES) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}

const SLOTS = buildSlots();

/** Snap HH:mm to nearest 5-minute slot. */
export function snapHmToStep(value: string, step = STEP_MINUTES): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return '';
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) return '';
  const total = h * 60 + m;
  const snapped = Math.round(total / step) * step;
  const clamped = Math.min(23 * 60 + (60 - step), Math.max(0, snapped));
  const nh = Math.floor(clamped / 60) % 24;
  const nm = clamped % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

export function TimeSelect({
  id,
  value,
  onChange,
  disabled,
  placeholder = '—:—',
  className,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}): ReactElement {
  const options = useMemo(() => SLOTS, []);
  const normalized = value ? snapHmToStep(value) || value : '';

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      value={normalized}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'flex h-11 w-full appearance-none rounded-2xl border border-border bg-card bg-[length:1rem] bg-[right_0.85rem_center] bg-no-repeat px-4 pr-10 text-base tabular-nums outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-70 sm:text-sm',
        'bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 fill=%27none%27 stroke=%27%236b7280%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27m4 6 4 4 4-4%27/%3E%3C/svg%3E")]',
        !normalized && 'text-muted-foreground',
        className,
      )}
    >
      <option value="">{placeholder}</option>
      {options.map((slot) => (
        <option key={slot} value={slot}>
          {slot}
        </option>
      ))}
    </select>
  );
}
