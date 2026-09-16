import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-95',
        outline: 'border border-border bg-card text-foreground hover:bg-muted',
        soft: 'bg-muted text-foreground hover:bg-border/80',
        ghost: 'hover:bg-muted',
        destructive: 'bg-destructive text-white hover:brightness-95',
      },
      size: {
        default: 'h-10 min-h-10 px-4 py-2',
        sm: 'h-9 min-h-9 px-3 text-xs sm:h-8 sm:min-h-8',
        icon: 'h-10 w-10 min-h-10 min-w-10 rounded-full p-0 sm:h-9 sm:w-9 sm:min-h-9 sm:min-w-9',
        'icon-sm':
          'h-10 w-10 min-h-10 min-w-10 rounded-full p-0 sm:h-8 sm:w-8 sm:min-h-8 sm:min-w-8',
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
