import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Fixed bottom action bar so save/cancel stay visible while editing. */
export function StickyActionBar({
  children,
  className,
  scoped = true,
}: {
  children: ReactNode;
  className?: string;
  /** When true (default), on lg screens offset left by sidebar width so the bar covers only main content. */
  scoped?: boolean;
}): ReactElement {
  return (
    <div
      className={cn(
        'fixed bottom-0 right-0 z-30 border-t border-border bg-background/95 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur supports-[backdrop-filter]:bg-background/90',
        'pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3',
        scoped ? 'left-0 lg:left-[232px]' : 'inset-x-0',
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-2.5 px-3.5 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-2 sm:px-5 md:px-6 lg:px-8">
        {children}
      </div>
    </div>
  );
}
