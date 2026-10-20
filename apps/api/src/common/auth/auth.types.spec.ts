import { AuthStrength, Role } from '@erp/shared';
import { isElevated, type AuthenticatedUser } from './auth.types';

describe('isElevated', () => {
  const base: AuthenticatedUser = {
    id: 'u1',
    name: 'U',
    login: 'u',
    role: Role.FLORIST,
    sessionId: 's1',
    isActive: true,
  };

  it('is false without elevatedUntil', () => {
    expect(isElevated({ ...base, authStrength: AuthStrength.PASSWORD })).toBe(false);
  });

  it('is true for PIN session inside elevation window', () => {
    expect(
      isElevated({
        ...base,
        authStrength: AuthStrength.PIN,
        elevatedUntil: new Date(Date.now() + 60_000),
      }),
    ).toBe(true);
  });

  it('is false after elevation window expires', () => {
    expect(
      isElevated({
        ...base,
        authStrength: AuthStrength.PIN,
        elevatedUntil: new Date(Date.now() - 1_000),
      }),
    ).toBe(false);
  });
});
