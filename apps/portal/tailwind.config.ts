import type { Config } from 'tailwindcss';

/**
 * Design tokens for the ESS/MSS portal (step 1.4) — a distinct "grounded
 * teal" palette rather than the generic indigo/purple SaaS default, chosen
 * to read as calm and legible for a tool people open daily. Every spacing/
 * color utility used across the portal should come from here so the
 * screens read as one product, not a pile of one-off pages.
 *
 * RTL: this config intentionally does NOT reach for a Tailwind RTL plugin —
 * every component in this app uses Tailwind's built-in LOGICAL utilities
 * (`ms-*`/`me-*`/`ps-*`/`pe-*`/`text-start`/`text-end`/`start-*`/`end-*`)
 * instead of physical `ml-*`/`mr-*`/`left-*`/`right-*`, which already flip
 * correctly under `dir="rtl"` with no extra plugin — see
 * docs/conventions/frontend-ess-mss.md.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#effbf6',
          100: '#d7f3e7',
          200: '#b1e7d1',
          300: '#7fd4b6',
          400: '#4bba98',
          500: '#279e7d',
          600: '#1a7f65',
          700: '#176653',
          800: '#155144',
          900: '#124339',
          950: '#08251f',
        },
        sand: {
          50: '#faf9f6',
          100: '#f3f0ea',
          200: '#e7e0d3',
          300: '#d5c9b3',
          400: '#bda98a',
          500: '#a48d69',
        },
        ink: {
          50: '#f5f6f7',
          100: '#e6e8eb',
          200: '#cfd3d9',
          300: '#a7aeb8',
          // WCAG 2.1 AA color-contrast (1.4.3) fix (Phase 6.2) — the
          // original #788393 was only 3.84:1 on white, below the 4.5:1
          // normal-text minimum, and this token is used as secondary/
          // muted body text (table headers, empty-state copy, badge-free
          // labels) in ~170 places across the portal, always on a white or
          // near-white (sand-50) background — never on a dark surface (see
          // docs/conventions/security-hardening.md's accessibility
          // findings) — so it's corrected at the TOKEN, not per call site.
          // #657084 clears 4.5:1 on both white (5.00:1) and sand-50
          // (4.74:1) with headroom, while staying visually distinct from
          // ink-500.
          400: '#657084',
          500: '#5b6577',
          600: '#454d5c',
          700: '#343a46',
          800: '#22262e',
          900: '#15171c',
          950: '#0b0c0f',
        },
        amber: {
          50: '#fdf8ed',
          400: '#eeab2f',
          500: '#d68f1a',
          // WCAG 2.1 AA color-contrast fix (Phase 6.2) — the original
          // #b3730f was 3.69:1 against amber-50, below 4.5:1, and this is
          // the ONLY consumer of amber-600 (Badge.tsx's "warning" tone —
          // PENDING/LATE/HIGH-priority status badges). #94600d clears
          // 5.03:1.
          600: '#94600d',
        },
        coral: {
          50: '#fdf1ef',
          400: '#e88268',
          500: '#d4644a',
          600: '#b34a34',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        arabic: ['var(--font-noto-kufi)', 'var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(11,12,15,0.04), 0 8px 24px -12px rgba(11,12,15,0.12)',
        card: '0 1px 3px rgba(11,12,15,0.06), 0 1px 2px rgba(11,12,15,0.04)',
      },
    },
  },
  plugins: [],
};

export default config;
