const SENSITIVE_KEY_EXACT = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'setcookie',
  'secret',
  'jwt',
  'tokenhash',
  'previoustokenhash',
  'apikey',
  'api_key',
]);

const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'authorization',
  'cookie',
  'tokenhash',
];

const MAX_AUDIT_DEPTH = 6;
const MAX_AUDIT_KEYS = 50;
const MAX_AUDIT_STRING = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s_-]/g, '');
  if (SENSITIVE_KEY_EXACT.has(normalized)) {
    return true;
  }
  // Avoid stripping every key that merely contains "token" (e.g. entity tokens).
  if (normalized === 'refreshtoken' || normalized === 'accesstoken' || normalized === 'token') {
    return true;
  }
  return SENSITIVE_KEY_SUBSTRINGS.some((part) => normalized.includes(part));
}

function truncateString(value: string): string {
  if (value.length <= MAX_AUDIT_STRING) {
    return value;
  }
  return `${value.slice(0, MAX_AUDIT_STRING)}…`;
}

export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_AUDIT_DEPTH) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_AUDIT_KEYS).map((item) => sanitizeForAudit(item, depth + 1));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (count >= MAX_AUDIT_KEYS) {
      result._truncated = true;
      break;
    }
    if (isSensitiveKey(key)) {
      continue;
    }
    result[key] = sanitizeForAudit(nested, depth + 1);
    count += 1;
  }

  return result;
}

export function toPublicUser(
  user: {
    id: string;
    name: string;
    login: string;
    email?: string | null;
    role: string;
    isActive: boolean;
    lastLoginAt: Date | null;
    lastLoginUserAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  sessionStats?: { hasActiveSession: boolean; activeSessionCount: number },
): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    email: user.email ?? null,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lastLoginUserAgent: user.lastLoginUserAgent ?? null,
    hasActiveSession: sessionStats?.hasActiveSession ?? false,
    activeSessionCount: sessionStats?.activeSessionCount ?? 0,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
