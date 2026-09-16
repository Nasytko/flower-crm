export type NodeEnv = 'development' | 'test' | 'production';

export interface AppEnv {
  NODE_ENV: NodeEnv;
  DATABASE_URL: string;
  API_PORT: number;
  WEB_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  SESSION_TTL_SECONDS: number;
  AUTH_COOKIE_NAME: string;
  AUTH_LOGIN_MAX_ATTEMPTS: number;
  AUTH_LOGIN_WINDOW_SECONDS: number;
  TRUST_PROXY: false | number;
  BUSINESS_TIME_ZONE: string;
}

const NODE_ENV_VALUES = new Set<NodeEnv>(['development', 'test', 'production']);

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  errors: string[],
  min = 1,
): number {
  const raw = readString(config, key);
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${key} must be an integer >= ${min}`);
    return fallback;
  }

  return value;
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const errors: string[] = [];

  const nodeEnvRaw = readString(config, 'NODE_ENV') ?? 'development';
  if (!NODE_ENV_VALUES.has(nodeEnvRaw as NodeEnv)) {
    errors.push('NODE_ENV must be one of: development, test, production');
  }

  const databaseUrl = readString(config, 'DATABASE_URL');
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required');
  } else if (!isValidDatabaseUrl(databaseUrl)) {
    errors.push('DATABASE_URL must be a valid postgresql:// connection URL');
  }

  const apiPort = readInteger(config, 'API_PORT', 3001, errors, 1);
  if (apiPort > 65535) {
    errors.push('API_PORT must be an integer between 1 and 65535');
  }

  const webUrl = readString(config, 'WEB_URL');
  if (!webUrl) {
    errors.push('WEB_URL is required');
  } else if (!isValidUrl(webUrl)) {
    errors.push('WEB_URL must be a valid http(s) URL');
  }

  const jwtAccessSecret = readString(config, 'JWT_ACCESS_SECRET');
  if (!jwtAccessSecret) {
    errors.push('JWT_ACCESS_SECRET is required');
  } else if (jwtAccessSecret.length < 32) {
    errors.push('JWT_ACCESS_SECRET must be at least 32 characters');
  }

  const jwtAccessTtlSeconds = readInteger(config, 'JWT_ACCESS_TTL_SECONDS', 900, errors, 60);
  const sessionTtlSeconds = readInteger(config, 'SESSION_TTL_SECONDS', 1_209_600, errors, 60);
  const authCookieName = readString(config, 'AUTH_COOKIE_NAME') ?? 'erp_refresh';
  const authLoginMaxAttempts = readInteger(config, 'AUTH_LOGIN_MAX_ATTEMPTS', 20, errors, 1);
  const authLoginWindowSeconds = readInteger(config, 'AUTH_LOGIN_WINDOW_SECONDS', 60, errors, 1);
  const trustProxy = readTrustProxy(config, errors);
  const businessTimeZone = readBusinessTimeZone(config, errors);

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return {
    NODE_ENV: nodeEnvRaw as NodeEnv,
    DATABASE_URL: databaseUrl as string,
    API_PORT: apiPort,
    WEB_URL: webUrl as string,
    JWT_ACCESS_SECRET: jwtAccessSecret as string,
    JWT_ACCESS_TTL_SECONDS: jwtAccessTtlSeconds,
    SESSION_TTL_SECONDS: sessionTtlSeconds,
    AUTH_COOKIE_NAME: authCookieName,
    AUTH_LOGIN_MAX_ATTEMPTS: authLoginMaxAttempts,
    AUTH_LOGIN_WINDOW_SECONDS: authLoginWindowSeconds,
    TRUST_PROXY: trustProxy,
    BUSINESS_TIME_ZONE: businessTimeZone,
  };
}

function readBusinessTimeZone(config: Record<string, unknown>, errors: string[]): string {
  const raw = readString(config, 'BUSINESS_TIME_ZONE') ?? 'Europe/Minsk';
  try {
    // Throws RangeError for unknown IANA zones.
    Intl.DateTimeFormat(undefined, { timeZone: raw });
    return raw;
  } catch {
    errors.push('BUSINESS_TIME_ZONE must be a valid IANA time zone (e.g. Europe/Minsk)');
    return 'Europe/Minsk';
  }
}

function readTrustProxy(config: Record<string, unknown>, errors: string[]): false | number {
  const raw = readString(config, 'TRUST_PROXY');
  if (raw === undefined || raw === 'false' || raw === '0') {
    return false;
  }
  if (raw === 'true') {
    return 1;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    errors.push('TRUST_PROXY must be false, true, or a non-negative integer (hop count)');
    return false;
  }
  return value;
}
