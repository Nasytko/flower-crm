import { validateEnv } from './env.validation';

const validEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/flower_crm?schema=public',
  API_PORT: '3001',
  WEB_URL: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'local-dev-access-secret-change-me-32chars',
  JWT_ACCESS_TTL_SECONDS: '900',
  SESSION_TTL_SECONDS: '1209600',
  AUTH_COOKIE_NAME: 'erp_refresh',
  AUTH_LOGIN_MAX_ATTEMPTS: '20',
  AUTH_LOGIN_WINDOW_SECONDS: '60',
};

describe('validateEnv', () => {
  it('parses a valid configuration', () => {
    expect(validateEnv(validEnv)).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: validEnv.DATABASE_URL,
      API_PORT: 3001,
      WEB_URL: 'http://localhost:3000',
      JWT_ACCESS_SECRET: validEnv.JWT_ACCESS_SECRET,
      JWT_ACCESS_TTL_SECONDS: 900,
      SESSION_TTL_SECONDS: 1_209_600,
      AUTH_COOKIE_NAME: 'erp_refresh',
      AUTH_LOGIN_MAX_ATTEMPTS: 20,
      AUTH_LOGIN_WINDOW_SECONDS: 60,
      TRUST_PROXY: false,
      BUSINESS_TIME_ZONE: 'Europe/Minsk',
    });
  });

  it('fails fast when required values are missing', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL is required/);
    expect(() => validateEnv({})).toThrow(/WEB_URL is required/);
    expect(() => validateEnv({})).toThrow(/JWT_ACCESS_SECRET is required/);
  });

  it('rejects a short JWT secret', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        JWT_ACCESS_SECRET: 'too-short',
      }),
    ).toThrow(/JWT_ACCESS_SECRET must be at least 32 characters/);
  });

  it('rejects an invalid database URL', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        DATABASE_URL: 'mysql://localhost/flower_crm',
      }),
    ).toThrow(/DATABASE_URL must be a valid postgresql:\/\/ connection URL/);
  });

  it('rejects an invalid API_PORT', () => {
    expect(() => validateEnv({ ...validEnv, API_PORT: 'abc' })).toThrow(/API_PORT/);
  });

  it('parses TRUST_PROXY', () => {
    expect(validateEnv({ ...validEnv, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(validateEnv({ ...validEnv, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(1);
    expect(validateEnv({ ...validEnv, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
  });
});
