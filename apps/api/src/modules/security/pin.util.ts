import { randomInt } from 'node:crypto';
import { PIN_LENGTH, type PinStatus } from '@erp/shared';
import { hashPassword, verifyPassword } from '../../common/security/password';

/** Cryptographically random numeric PIN with leading zeros preserved. */
export function generatePinPlaintext(length = PIN_LENGTH): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, '0');
}

export async function hashPin(pin: string): Promise<string> {
  return hashPassword(pin);
}

export async function verifyPin(pinHash: string, pin: string): Promise<boolean> {
  return verifyPassword(pinHash, pin);
}

export function assertPinFormat(pin: string, length = PIN_LENGTH): boolean {
  return new RegExp(`^\\d{${length}}$`).test(pin);
}

export function computePinStatus(user: {
  pinEnabled: boolean;
  pinHash: string | null;
  pinLockedUntil: Date | null;
}): PinStatus {
  if (!user.pinEnabled) return 'DISABLED';
  if (!user.pinHash) return 'NOT_SET';
  if (user.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now()) return 'TEMP_LOCKED';
  return 'ACTIVE';
}
