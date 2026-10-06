import type { Config } from 'tailwindcss';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- a CommonJS preset (kept CJS so it needs no build step and no tailwindcss dependency of its own).
const mbnPreset = require('@hrm/config/tailwind-preset');

/**
 * The tenant portal's Tailwind config — intentionally thin. Every color,
 * font, radius, shadow and base style comes from the SHARED MBN preset
 * (`@hrm/config/tailwind-preset`, tokens in `@hrm/config/design-tokens.css`),
 * which apps/admin consumes too — see docs/conventions/design-system.md.
 * Change a color there, not here.
 *
 * RTL: this config intentionally does NOT reach for a Tailwind RTL plugin —
 * every component in this app uses Tailwind's built-in LOGICAL utilities
 * (`ms-*`/`me-*`/`ps-*`/`pe-*`/`text-start`/`text-end`/`start-*`/`end-*`)
 * instead of physical `ml-*`/`mr-*`/`left-*`/`right-*`, which already flip
 * correctly under `dir="rtl"` with no extra plugin — see
 * docs/conventions/frontend-ess-mss.md.
 */
const config: Config = {
  presets: [mbnPreset],
  content: ['./src/**/*.{ts,tsx}'],
};

export default config;
