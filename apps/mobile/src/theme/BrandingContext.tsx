import React, { createContext, useContext, useEffect, useState } from 'react';
import { getPublicBranding } from '../lib/api/branding';
import { useAuth } from '../lib/auth/AuthContext';
import type { PublicBranding } from '../lib/api/types';

const DEFAULT_BRANDING: PublicBranding = {
  productName: 'HRM',
  hasLogo: false,
  hasFavicon: false,
  primaryColor: null,
  secondaryColor: null,
  accentColor: null,
  loginHeadline: null,
  loginSubtext: null,
  showPoweredBy: true,
};

interface BrandingContextValue {
  branding: PublicBranding;
  ready: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({ branding: DEFAULT_BRANDING, ready: false });

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}

/**
 * Mirrors apps/portal's `BrandingProvider` (see
 * docs/conventions/white-label.md) — mounted in `App.tsx` INSIDE
 * `<AuthProvider>`, and **re-fetches whenever `user` changes**, not just
 * once on mount. This matters even MORE here than on the web portal:
 * mobile has no hostname of its own at all (see src/lib/tenant.ts) and
 * ALWAYS uses the header tenant-resolution strategy, so on a genuinely
 * fresh install the very first resolution attempt (on mount, pre-login)
 * legitimately has no stored tenant slug to send and falls back to the
 * plain defaults — `AuthContext.login()` stores the slug BEFORE it ever
 * updates `user`, so re-running this effect on that transition is what
 * picks up the REAL branding instead of staying stuck on the default.
 *
 * Deliberately does NOT fetch the logo/favicon image (unlike the web
 * portal's object-URL pattern) — see PublicBranding's own doc comment in
 * lib/api/types.ts for why that's a documented gap, not an oversight.
 */
export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [branding, setBranding] = useState<PublicBranding>(DEFAULT_BRANDING);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPublicBranding()
      .then((resolved) => {
        if (!cancelled) setBranding(resolved);
      })
      .catch(() => {
        // No resolvable tenant yet, or the network call otherwise failed —
        // the plain defaults stand. Never throw: a branding failure must
        // never block the app from rendering.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return <BrandingContext.Provider value={{ branding, ready }}>{children}</BrandingContext.Provider>;
}
