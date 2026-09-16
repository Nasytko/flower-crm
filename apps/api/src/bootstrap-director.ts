/**
 * One-shot CLI: create the first production DIRECTOR when User table is empty.
 *
 * Credentials via env (never logged):
 *   BOOTSTRAP_DIRECTOR_NAME
 *   BOOTSTRAP_DIRECTOR_LOGIN
 *   BOOTSTRAP_DIRECTOR_EMAIL (optional)
 *   BOOTSTRAP_DIRECTOR_PASSWORD
 *
 * Usage: node dist/bootstrap-director.js
 *        pnpm run bootstrap:director
 */
import { createPrismaClient } from '@erp/database';
import { Role } from '@erp/shared';
import { hashPassword } from './common/security/password';

/** Transaction-scoped advisory lock pair — unique to this bootstrap path. */
const BOOTSTRAP_LOCK_KEY1 = 0x4e455250; // 'NERP'
const BOOTSTRAP_LOCK_KEY2 = 0x0000d001;

const LOGIN_PATTERN = /^[a-zA-Z0-9._-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEmail(): string | null {
  const raw = process.env.BOOTSTRAP_DIRECTOR_EMAIL?.trim() ?? '';
  if (!raw) return null;
  if (raw.length > 120 || !EMAIL_PATTERN.test(raw)) {
    throw new Error('BOOTSTRAP_DIRECTOR_EMAIL must be a valid email (max 120 chars)');
  }
  return raw;
}

function validateCredentials(input: {
  name: string;
  login: string;
  password: string;
}): void {
  if (input.name.length < 2 || input.name.length > 120) {
    throw new Error('BOOTSTRAP_DIRECTOR_NAME must be 2–120 characters');
  }
  if (input.login.length < 2 || input.login.length > 64 || !LOGIN_PATTERN.test(input.login)) {
    throw new Error(
      'BOOTSTRAP_DIRECTOR_LOGIN must be 2–64 chars and match [a-zA-Z0-9._-]+',
    );
  }
  if (input.password.length < 10 || input.password.length > 128) {
    throw new Error('BOOTSTRAP_DIRECTOR_PASSWORD must be 10–128 characters');
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const name = requireEnv('BOOTSTRAP_DIRECTOR_NAME');
  const login = requireEnv('BOOTSTRAP_DIRECTOR_LOGIN');
  const password = requireEnv('BOOTSTRAP_DIRECTOR_PASSWORD');
  const email = optionalEmail();
  validateCredentials({ name, login, password });

  const prisma = createPrismaClient(databaseUrl);

  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY1}, ${BOOTSTRAP_LOCK_KEY2})`;

      const existingCount = await tx.user.count();
      if (existingCount > 0) {
        throw new Error(
          `Bootstrap refused: database already has ${existingCount} user(s). One-shot only.`,
        );
      }

      const passwordHash = await hashPassword(password);
      return tx.user.create({
        data: {
          name,
          login,
          email,
          passwordHash,
          role: Role.DIRECTOR,
          isActive: true,
        },
        select: {
          id: true,
          login: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });
    });

    // Intentionally omit password / passwordHash.
    console.log(
      JSON.stringify({
        ok: true,
        message: 'First DIRECTOR created',
        user: created,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Bootstrap failed';
  // Never echo env values or stacks that might include secrets from wrappers.
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
