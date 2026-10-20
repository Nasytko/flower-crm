import { AuthStrength, Role } from '@erp/shared';

export interface AuthenticatedUser {
  id: string;
  name: string;
  login: string;
  email?: string | null;
  role: Role;
  sessionId: string;
  isActive: boolean;
  /** Defaults to PASSWORD for legacy test actors without workstation fields. */
  authStrength?: AuthStrength;
  elevatedUntil?: Date | null;
  workSessionId?: string | null;
  lockedAt?: Date | null;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Step-up window after password re-verification.
 * Does not permanently change authStrength — PIN sessions stay PIN after the window expires.
 */
export function isElevated(user: AuthenticatedUser, now = new Date()): boolean {
  if (!user.elevatedUntil) {
    return false;
  }
  return user.elevatedUntil.getTime() > now.getTime();
}
