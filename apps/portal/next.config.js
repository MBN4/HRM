/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@hrm/shared'],
  // Phase 5.3 — a self-contained `.next/standalone` build (only the
  // production deps this app actually needs, traced from its own import
  // graph) is what apps/portal/Dockerfile copies into its runtime image —
  // see docs/conventions/deployment-scaling.md. Purely additive: `next
  // dev`/`next start` are unaffected, this only changes what `next build`
  // additionally emits.
  output: 'standalone',
};

module.exports = nextConfig;
