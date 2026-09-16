import * as argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options = {
  // OWASP minimum for Argon2id (m=19456 KiB ≈ 19 MiB, t=2, p=1).
  // Raise memoryCost after load testing if threat model requires stronger offline resistance.
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Lazily generated Argon2id hash used to equalize login timing for missing/inactive accounts. */
let resolvedDummyHash: string | null = null;

async function resolveDummyPasswordHash(): Promise<string> {
  if (resolvedDummyHash) {
    return resolvedDummyHash;
  }
  resolvedDummyHash = await argon2.hash('dummy-timing-equalizer', ARGON2_OPTIONS);
  return resolvedDummyHash;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Runs Argon2 verification without revealing whether the outcome matters to the caller. */
export async function runDummyPasswordVerification(password: string): Promise<void> {
  const hash = await resolveDummyPasswordHash();
  await verifyPassword(hash, password);
}
