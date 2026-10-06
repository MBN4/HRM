import { BRAND_NAME } from '../../lib/brand';

/** The MBN monogram — a rounded tile holding a minimal "M" built from two peaks (a stylised growth/people mark), in the brand greens. Pure inline SVG: no image dependency. */
export function BrandMark({ className = 'h-9 w-9', tone = 'color' }: { className?: string; tone?: 'color' | 'light' }) {
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label={BRAND_NAME} data-testid="brand-mark">
      <defs>
        <linearGradient id="mbn-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2e9e7e" />
          <stop offset="1" stopColor="#0b5d46" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill={tone === 'light' ? '#ffffff' : 'url(#mbn-mark-gradient)'} />
      <path
        d="M10.5 28V13.5l9.5 9.5 9.5-9.5V28"
        fill="none"
        stroke={tone === 'light' ? '#0b5d46' : '#ffffff'}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="30.5" cy="11" r="2.2" fill={tone === 'light' ? '#2e9e7e' : '#7fe0bf'} />
    </svg>
  );
}

/**
 * Mark + wordmark lockup. `name` is the live (possibly tenant-white-labelled)
 * product name; with no tenant override it is the static brand constant and
 * the MBN monogram renders. A tenant that set its own name/logo gets its
 * uploaded logo, or a neutral initial tile — never MBN's monogram on
 * someone else's product. `tone="light"` is for dark backgrounds.
 */
export function Wordmark({
  name = BRAND_NAME,
  logoUrl = null,
  tone = 'color',
  size = 'md',
  suffix,
  tint = null,
  testId = 'branding-product-name',
}: {
  name?: string;
  logoUrl?: string | null;
  tone?: 'color' | 'light';
  size?: 'md' | 'lg';
  /** A tenant's own primary color for the neutral initial tile (white-label, 4.3). */
  tint?: string | null;
  /** Secondary label under the name (e.g. "Vendor Console"). */
  suffix?: string;
  testId?: string;
}) {
  const big = size === 'lg';
  const box = big ? 'h-11 w-11' : 'h-9 w-9';
  return (
    <span className="inline-flex items-center gap-2.5">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a tenant-branded logo is an arbitrary uploaded image, not a build-time static asset next/image can optimize.
        <img src={logoUrl} alt={name} className={`${box} rounded-xl object-contain`} data-testid="branding-logo" />
      ) : name === BRAND_NAME ? (
        <BrandMark tone={tone} className={box} />
      ) : (
        <span
          className={`${box} flex items-center justify-center rounded-xl text-lg font-bold ${tone === 'light' ? 'bg-white text-[#0b5d46]' : 'bg-primary text-white'}`}
          style={tint ? { color: tint } : undefined}
          data-testid="branding-badge"
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="flex flex-col leading-none">
        <span
          className={`font-bold tracking-tight ${big ? 'text-2xl' : 'text-lg'} ${tone === 'light' ? 'text-white' : 'text-ink-900'}`}
          data-testid={testId}
        >
          {name}
        </span>
        {suffix && <span className={`eyebrow mt-1 ${tone === 'light' ? 'text-sidebar-fg' : 'text-ink-500'}`}>{suffix}</span>}
      </span>
    </span>
  );
}
