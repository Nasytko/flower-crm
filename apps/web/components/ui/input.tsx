import * as React from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: React.ComponentProps<'input'>): React.ReactElement {
  return (
    <input
      className={cn(
        'flex h-11 w-full rounded-2xl border border-border bg-card px-4 py-2 text-base outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 sm:rounded-full sm:text-sm',
        className,
      )}
      {...props}
    />
  );
}
