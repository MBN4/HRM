import type { Config } from 'tailwindcss';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- a CommonJS preset (kept CJS so it needs no build step and no tailwindcss dependency of its own).
const mbnPreset = require('@hrm/config/tailwind-preset');

/**
 * The vendor console's Tailwind config — intentionally thin. Every color,
 * font, radius, shadow and base style comes from the SHARED MBN preset
 * (`@hrm/config/tailwind-preset`, tokens in `@hrm/config/design-tokens.css`),
 * which apps/portal consumes too — see docs/conventions/design-system.md.
 * Change a color there, not here. The vendor console's own identity vs. the
 * portal comes from the near-black sidebar token in its globals.css and the
 * "Vendor Console" lockup, not from a different palette.
 */
const config: Config = {
  presets: [mbnPreset],
  // packages/ui ships Tailwind classes (the shared sidebar), so its source must be scanned too.
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};

export default config;
