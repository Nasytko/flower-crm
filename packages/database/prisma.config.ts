import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// dotenv is optional: local/dev may load ../../.env; production containers inject DATABASE_URL.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require('dotenv') as { config: (opts: { path: string }) => void };
  dotenv.config({ path: resolve(__dirname, '../../.env') });
} catch {
  // ignore missing dotenv in slim production/migrate images
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/flower_crm?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
