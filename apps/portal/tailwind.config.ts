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
          400: '#788393',
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
          600: '#b3730f',
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
