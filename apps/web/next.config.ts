import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const require = createRequire(import.meta.url);
const configDir = dirname(fileURLToPath(import.meta.url));

function loadRootPublicEnv(): void {
  const envPath = resolve(configDir, '../../.env');

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

function resolvePackage(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

const reactPath = resolvePackage('react');
const reactDomPath = resolvePackage('react-dom');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  transpilePackages: ['@erp/shared'],
  agentRules: false,
  // Production Docker image uses the standalone server output.
  output: 'standalone',
  // Next 16 defaults to Turbopack in `next dev`; keep an explicit empty/alias
  // config so the webpack() block below does not abort the dev server.
  turbopack: {
    resolveAlias: {
      react: reactPath,
      'react-dom': reactDomPath,
    },
  },
  // Prevent duplicate React copies in monorepo Docker builds (breaks prerender).
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      react: reactPath,
      'react-dom': reactDomPath,
    };
    return config;
  },
};

export default nextConfig;
