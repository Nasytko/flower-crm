process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5432/flower_crm?schema=public';
process.env.API_PORT ??= '3001';
process.env.WEB_URL ??= 'http://localhost:3000';
process.env.JWT_ACCESS_SECRET ??= 'local-dev-access-secret-change-me-32chars';
process.env.JWT_ACCESS_TTL_SECONDS ??= '900';
process.env.SESSION_TTL_SECONDS ??= '1209600';
process.env.AUTH_COOKIE_NAME ??= 'erp_refresh';
process.env.AUTH_LOGIN_MAX_ATTEMPTS ??= '20';
process.env.AUTH_LOGIN_WINDOW_SECONDS ??= '60';
process.env.BUSINESS_TIME_ZONE ??= 'Europe/Minsk';
process.env.TRUST_PROXY ??= 'false';

/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(e2e-)?spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(?:@nestjs/jwt|jose)/)'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // Live PostgreSQL suites share one DB + warehouse advisory lock; parallel workers race.
  maxWorkers: 1,
};
