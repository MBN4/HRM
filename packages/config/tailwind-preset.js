/**
 * MBN shared Tailwind preset — consumed by apps/portal AND apps/admin so the
 * two apps are one design system (docs/conventions/design-system.md). Every
 * color resolves to a CSS variable defined in ./design-tokens.css (which
 * each app's globals.css imports), so light/dark is a pure variable swap.
 *
 * RTL: components use Tailwind's LOGICAL utilities (ms-/me-/ps-/pe-/start-/
 * end-/text-start/border-e) exclusively — nothing here introduces a physical
 * left/right, and the plugin below follows the same rule.
 */
// A Tailwind plugin is just `{ handler }` — written out directly so this package needs no `tailwindcss` dependency of its own (pnpm would not resolve it from here).
const plugin = (handler) => ({ handler });

const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
// Plain (alpha-less) color for use inside the plugin below — `theme('colors.x')` would leak the `<alpha-value>` placeholder.
const c = (name) => `rgb(var(--c-${name}))`;
const ramp = (name, shades) => Object.fromEntries(shades.map((s) => [s, v(`${name}-${s}`)]));

const FULL = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

module.exports = {
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: ramp('brand', FULL),
        accent: ramp('accent', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        sand: ramp('sand', [50, 100, 200, 300, 400, 500]),
        ink: ramp('ink', FULL),
        amber: ramp('amber', [50, 100, 200, 400, 500, 600, 700, 800]),
        coral: ramp('coral', [50, 100, 200, 300, 400, 500, 600, 700]),
        sky: ramp('sky', [50, 100, 200, 400, 500, 600, 700]),
        // Non-flipping solid fills (stay dark enough for white text in BOTH modes).
        primary: { DEFAULT: v('primary'), hover: v('primary-hover') },
        danger: { DEFAULT: v('danger'), hover: v('danger-hover') },
        // Card / panel surface (white in light, raised near-black in dark).
        surface: { DEFAULT: v('surface'), raised: v('surface-raised') },
        // App-shell sidebar — set per app (--c-sidebar) so the two apps stay distinguishable.
        sidebar: { DEFAULT: v('sidebar'), fg: v('sidebar-fg') },
        chart: { 1: v('chart-1'), 2: v('chart-2'), 3: v('chart-3'), 4: v('chart-4'), 5: v('chart-5') },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        arabic: ['var(--font-noto-kufi)', 'var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl2: '1rem' },
      boxShadow: {
        card: '0 1px 2px rgb(10 14 13 / 0.05), 0 1px 3px rgb(10 14 13 / 0.04)',
        soft: '0 1px 2px rgb(10 14 13 / 0.05), 0 12px 32px -12px rgb(10 14 13 / 0.18)',
        pop: '0 4px 8px -2px rgb(10 14 13 / 0.08), 0 24px 48px -16px rgb(10 14 13 / 0.28)',
      },
    },
  },
  plugins: [
    plugin(({ addBase, addComponents, theme }) => {
      addBase({
        body: {
          backgroundColor: c('sand-50'),
          color: c('ink-900'),
          fontFamily: theme('fontFamily.sans'),
          lineHeight: '1.55',
          '-webkit-font-smoothing': 'antialiased',
        },
        // Arabic-script locales: the font stack swaps; line-height opens up for the taller glyphs.
        "[dir='rtl'] body": { fontFamily: theme('fontFamily.arabic'), lineHeight: '1.75' },
        'h1, h2, h3': { letterSpacing: '-0.01em' },
        "[dir='rtl'] h1, [dir='rtl'] h2, [dir='rtl'] h3": { letterSpacing: '0' },
        ':focus-visible': {
          outline: 'none',
          boxShadow: `0 0 0 2px ${c('sand-50')}, 0 0 0 4px ${c('accent-500')}`,
        },
        '::selection': { backgroundColor: c('accent-200'), color: c('ink-950') },
        // Tables — every table in both apps is plain markup (no shared <Table>), so the
        // header/row treatment lives here once instead of in ~40 call sites.
        'table thead th': {
          fontSize: '0.75rem',
          fontWeight: '600',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: c('ink-500'),
        },
        "[dir='rtl'] table thead th": { letterSpacing: '0', textTransform: 'none' },
        'table tbody tr': { transition: 'background-color 120ms ease' },
        'table tbody tr:hover': { backgroundColor: c('sand-100') },
        'input[type=checkbox], input[type=radio]': { accentColor: c('brand-600') },
      });

      addComponents({
        // Type scale — page-level heading / subheading / section eyebrow.
        '.page-title': {
          fontSize: '1.5rem',
          lineHeight: '2rem',
          fontWeight: '650',
          letterSpacing: '-0.02em',
          color: c('ink-900'),
        },
        '.page-subtitle': { marginTop: '0.25rem', fontSize: '0.875rem', color: c('ink-500') },
        '.eyebrow': {
          fontSize: '0.6875rem',
          fontWeight: '600',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        },
        // Login/auth backdrop — layered radial glows over a deep-green base + a faint grid.
        '.auth-backdrop': {
          position: 'relative',
          isolation: 'isolate',
          overflow: 'hidden',
          backgroundColor: c('auth-base'),
          backgroundImage: [
            `radial-gradient(60rem 36rem at 15% -10%, rgb(var(--c-glow-a) / 0.28), transparent 60%)`,
            `radial-gradient(48rem 32rem at 100% 110%, rgb(var(--c-glow-b) / 0.35), transparent 60%)`,
            `linear-gradient(160deg, rgb(var(--c-auth-top)), rgb(var(--c-auth-base)))`,
          ].join(', '),
        },
        '.auth-backdrop::before': {
          content: '""',
          position: 'absolute',
          inset: '0',
          zIndex: '-1',
          opacity: '0.07',
          backgroundImage:
            'linear-gradient(rgb(255 255 255) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
        },
        '.auth-card': {
          borderRadius: theme('borderRadius.xl2'),
          backgroundColor: c('surface'),
          padding: '2rem',
          boxShadow: theme('boxShadow.pop'),
          border: '1px solid rgb(255 255 255 / 0.08)',
        },
      });
    }),
  ],
};
