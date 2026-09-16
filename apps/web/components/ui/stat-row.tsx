import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Compact label/value row for mobile entity cards. */
export function StatRow({
  label,
  value,
  emphasize,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  emphasize?: boolean;
  className?: string;
}): ReactElement {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-sm', className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', emphasize && 'font-semibold')}>{value}</span>
    </div>
  );
}
