import { AuditAction } from '@erp/shared';
import { AuditService } from './audit.service';
import { sanitizeForAudit } from '../../common/security/sanitize';

describe('audit sanitization', () => {
  it('removes password and token fields including nested and case variants', () => {
    const sanitized = sanitizeForAudit({
      login: 'anna',
      password: 'secret',
      PasswordHash: 'hash',
      nested: { refreshToken: 'raw', name: 'Anna', Authorization: 'Bearer x' },
      cookie: 'erp_refresh=abc',
      safeTokenLabel: 'order-42',
    }) as Record<string, unknown>;

    expect(sanitized.login).toBe('anna');
    expect(sanitized.password).toBeUndefined();
    expect(sanitized.PasswordHash).toBeUndefined();
    expect(sanitized.cookie).toBeUndefined();
    expect((sanitized.nested as Record<string, unknown>).name).toBe('Anna');
    expect((sanitized.nested as Record<string, unknown>).refreshToken).toBeUndefined();
    expect((sanitized.nested as Record<string, unknown>).Authorization).toBeUndefined();
    expect(sanitized.safeTokenLabel).toBe('order-42');
  });

  it('truncates oversized payloads', () => {
    const huge = 'x'.repeat(5000);
    const sanitized = sanitizeForAudit({ note: huge }) as Record<string, unknown>;
    expect(String(sanitized.note).endsWith('…')).toBe(true);
    expect(String(sanitized.note).length).toBeLessThan(huge.length);
  });
});

describe('AuditService', () => {
  it('persists sanitized payloads', async () => {
    const create = jest.fn();
    const prisma = { auditLog: { create } };
    const service = new AuditService(prisma as never);

    await service.log({
      action: AuditAction.LOGIN_SUCCESS,
      actorUserId: 'u1',
      entityType: 'User',
      entityId: 'u1',
      after: { login: 'director', passwordHash: 'nope' },
      metadata: { token: 'raw' },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        after: { login: 'director' },
        metadata: {},
      }),
    });
  });
});
