import type { ReactElement, ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Compact page title row used on all list screens. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h1>
        {description ? (
          <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

/** Single card that groups search + filters under the page title. */
export function ListToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={cn('overflow-hidden rounded-[24px] border border-border bg-card', className)}>
      {children}
    </div>
  );
}

export function ToolbarRow({
  children,
  className,
  divided,
}: {
  children: ReactNode;
  className?: string;
  /** Top border separator between toolbar rows */
  divided?: boolean;
}): ReactElement {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 px-3 py-2.5 sm:gap-2.5 sm:px-4',
        divided && 'border-t border-border/80',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Visual separator between filter clusters inside a toolbar row. */
export function ToolbarDivider({ className }: { className?: string }): ReactElement {
  return (
    <span
      className={cn('mx-0.5 hidden h-7 w-px shrink-0 bg-border sm:block', className)}
      aria-hidden
    />
  );
}

export function ToolbarSearch({
  value,
  onChange,
  onSubmit,
  placeholder,
  'aria-label': ariaLabel = 'Поиск',
  className,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  'aria-label'?: string;
  className?: string;
  id?: string;
}): ReactElement {
  return (
    <div className={cn('relative min-w-0 flex-1 basis-full sm:basis-[220px]', className)}>
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) onSubmit();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="h-10 rounded-2xl border-border/80 bg-background pl-10"
      />
    </div>
  );
}

/** Pill / chip toggle used for filters (type, scope, etc.). */
export function ToolbarChip({
  active,
  children,
  onClick,
  disabled,
  className,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm font-medium transition-colors disabled:opacity-50',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-foreground hover:bg-muted/80',
        className,
      )}
    >
      {children}
    </button>
  );
}
