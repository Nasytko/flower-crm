/**
 * Integration point for unsaved sales/orders before workstation lock or employee switch.
 * Future sales drafts module can register blockers here.
 */

type Blocker = () => string | null;

const blockers = new Set<Blocker>();

export function registerUnsavedWorkBlocker(blocker: Blocker): () => void {
  blockers.add(blocker);
  return () => {
    blockers.delete(blocker);
  };
}

/** Returns a human message if something would be lost, else null. */
export function getUnsavedWorkWarning(): string | null {
  for (const blocker of blockers) {
    const message = blocker();
    if (message) return message;
  }
  return null;
}

export function confirmLeaveUnsavedWork(): boolean {
  const warning = getUnsavedWorkWarning();
  if (!warning) return true;
  if (typeof window === 'undefined') return true;
  return window.confirm(
    `${warning}\n\nПродолжить? Несохранённые данные не будут переданы другому сотруднику.`,
  );
}
