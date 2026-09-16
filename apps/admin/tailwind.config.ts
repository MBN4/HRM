import type { Config } from 'tailwindcss';

/**
 * Design tokens for the vendor super-admin console (step 4.1). Deliberately
 * a DIFFERENT palette from apps/portal's "grounded teal" (indigo/slate here
 * vs. teal/sand there) — this is the single most dangerous surface in the
 * system (cross-tenant by nature), and giving it its own unmistakable
 * visual identity is part of making that legible at a glance: nobody
 * should be able to confuse a screenshot of this console with the tenant
 * portal. `coral` (danger) is reserved specifically for destructive
 * actions and the impersonation-active state — see components/ui/Alert.tsx
 * and the impersonation banner.
 *
 * Same token NAMES as apps/portal's tailwind.config.ts (brand/sand/ink/
 * amber/coral) so `components/ui/*` can be reused near-verbatim across
 * both apps — only the underlying hex values differ.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f1f0fe',
          100: '#e2e0fd',
          200: '#c5c1fb',
          300: '#a29bf7',
          400: '#8074f0',
          500: '#6152e8',
          600: '#4c3dd1',
          700: '#3d30a8',
          800: '#332a86',
          900: '#2c266b',
          950: '#1a1740',
        },
        sand: {
          50: '#f8f8fa',
          100: '#eeeef2',
          200: '#dcdce3',
          300: '#c2c2ce',
          400: '#a0a0b0',
          500: '#82829a',
        },
        ink: {
          50: '#f4f5f7',
          100: '#e5e7eb',
          200: '#ccd0d8',
          300: '#a2a9b6',
          // WCAG 2.1 AA color-contrast (1.4.3) fix (Phase 6.2) — the
          // original #767f91 was only 4.03:1 on white, below the 4.5:1
          // normal-text minimum (it only cleared 4.5:1 against the
          // Sidebar's own dark ink-900 background, a separate usage fixed
          // below by switching that ONE call site to ink-300 instead — see
          // docs/conventions/security-hardening.md's accessibility
          // findings). Every other ink-400 usage in this app is on a
          // white/light surface, so the token itself is corrected here.
          // #616a7a clears 4.5:1 on both white (5.45:1) and sand-50
          // (5.14:1) with headroom.
          400: '#616a7a',
          500: '#5a6377',
          600: '#454d5f',
          700: '#333947',
          800: '#1e222b',
          900: '#121419',
          950: '#08090c',
        },
        amber: {
          50: '#fdf7ed',
          400: '#eba93a',
          500: '#d38e1f',
          // WCAG 2.1 AA color-contrast fix (Phase 6.2) — the original
          // #af7213 was 3.76:1 against amber-50, below 4.5:1, and this is
          // the ONLY consumer of amber-600 (Badge.tsx's "warning" tone,
          // e.g. PAST_DUE/PENDING_VERIFICATION). #8f5e0e clears 5.22:1.
          600: '#8f5e0e',
        },
        coral: {
          50: '#fdf0ef',
          400: '#ea7266',
          500: '#dc5346',
          600: '#b93c31',
        },
        sky: {
          50: '#eef6fd',
          400: '#4fa9e8',
          500: '#2f8fd6',
          600: '#2371ac',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(8,9,12,0.05), 0 8px 24px -12px rgba(8,9,12,0.16)',
        card: '0 1px 3px rgba(8,9,12,0.07), 0 1px 2px rgba(8,9,12,0.05)',
      },
    },
  },
  plugins: [],
};

export default config;
