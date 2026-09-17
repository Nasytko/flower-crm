import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-95 active:brightness-90',
        outline: 'border border-border bg-card text-foreground hover:bg-muted active:bg-muted/80',
        soft: 'bg-muted text-foreground hover:bg-border/80',
        ghost: 'hover:bg-muted active:bg-muted/80',
        destructive: 'bg-destructive text-white hover:brightness-95',
      },
      size: {
        default: 'h-11 min-h-11 px-5 py-2 sm:h-10 sm:min-h-10 sm:px-4',
        sm: 'h-10 min-h-10 px-3.5 text-sm sm:h-9 sm:min-h-9 sm:px-3 sm:text-xs',
        icon: 'h-11 w-11 min-h-11 min-w-11 rounded-full p-0 sm:h-10 sm:w-10 sm:min-h-10 sm:min-w-10',
        'icon-sm':
          'h-10 w-10 min-h-10 min-w-10 rounded-full p-0 sm:h-9 sm:w-9 sm:min-h-9 sm:min-w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>): React.ReactElement {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
