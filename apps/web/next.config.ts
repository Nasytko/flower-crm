import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

function loadRootPublicEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env');

  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separator = trimmed.indexOf('=');
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key.startsWith('NEXT_PUBLIC_') && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // CI and production inject NEXT_PUBLIC_* without a local .env file.
  }
}

loadRootPublicEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  transpilePackages: ['@erp/shared'],
  agentRules: false,
};

export default nextConfig;
