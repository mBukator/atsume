import type { NextConfig } from 'next';

const config: NextConfig = {
  // better-sqlite3 and playwright are native or driver-backed; they must stay
  // external rather than being traced into the server bundle.
  serverExternalPackages: ['better-sqlite3', 'playwright'],
  experimental: {
    // Route handlers stream SSE; proxy buffering is handled per-response.
    proxyTimeout: 0,
  },
};

export default config;
