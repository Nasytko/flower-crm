import { SetMetadata } from '@nestjs/common';

export const ALLOW_LOCKED_KEY = 'allowLocked';

/** Permit AuthGuard when session.lockedAt is set (lock/status/activity edge cases). */
export const AllowLocked = () => SetMetadata(ALLOW_LOCKED_KEY, true);
