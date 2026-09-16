/**
 * Production CLI: reset password for an existing user by login.
 *
 * Env (never logged):
 *   CONFIRM_PRODUCTION_PASSWORD_RESET=YES
 *   RESET_USER_LOGIN
 *   RESET_USER_PASSWORD
 *
 * Usage: node dist/reset-user-password.js
 *        pnpm run reset:user-password
 */
import { createPrismaClient } from '@erp/database';
import { AuditAction } from '@erp/shared';
import { hashPassword } from './common/security/password';

async function main(): Promise<void> {
  if (process.env.CONFIRM_PRODUCTION_PASSWORD_RESET !== 'YES') {
    throw new Error('Refusing: set CONFIRM_PRODUCTION_PASSWORD_RESET=YES');
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const login = process.env.RESET_USER_LOGIN?.trim() ?? '';
  if (!login) {
    throw new Error('RESET_USER_LOGIN is required');
  }

  const password = process.env.RESET_USER_PASSWORD ?? '';
  if (password.length < 10 || password.length > 128) {
    throw new Error('RESET_USER_PASSWORD must be 10–128 characters');
  }

  const prisma = createPrismaClient(databaseUrl);

  try {
    const user = await prisma.user.findUnique({
      where: { login },
      select: { id: true, login: true },
    });
    if (!user) {
      throw new Error(`User not found for login: ${login}`);
    }

    const passwordHash = await hashPassword(password);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // System CLI event — actorUserId null is allowed by AuditLog schema.
      await tx.auditLog.create({
        data: {
          action: AuditAction.PASSWORD_RESET,
          entityType: 'User',
          entityId: user.id,
          metadata: {
            source: 'cli_reset_user_password',
            targetLogin: user.login,
          },
        },
      });
      await tx.auditLog.create({
        data: {
          action: AuditAction.SESSION_REVOKED,
          entityType: 'User',
          entityId: user.id,
          metadata: {
            source: 'cli_reset_user_password',
            reason: 'password_reset',
          },
        },
      });
    });

    console.log(
      JSON.stringify({
        ok: true,
        message: 'Password updated',
        user: { id: user.id, login: user.login },
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Password reset failed';
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
