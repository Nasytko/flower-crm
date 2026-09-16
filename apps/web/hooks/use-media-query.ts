'use client';

import { useEffect, useState } from 'react';

/** CSS-media-query hook for interaction-model switches only (e.g. Kanban tabs). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind `lg` — desktop Kanban columns / permanent sidebar. */
export function useIsLgUp(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}

/** Tailwind `md` — tablet-ish two-column forms. */
export function useIsMdUp(): boolean {
  return useMediaQuery('(min-width: 768px)');
}
