/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@hrm/shared'],
  // Phase 5.3 — see the identical note in apps/portal/next.config.js: a
  // self-contained `.next/standalone` build for apps/admin/Dockerfile.
  output: 'standalone',
};

module.exports = nextConfig;
