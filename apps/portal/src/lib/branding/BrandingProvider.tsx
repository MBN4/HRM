'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { fetchBrandingImage, getPublicBranding } from '../api/branding';
import { useAuth } from '../auth/AuthContext';
import type { PublicBranding } from '../api/types';

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
  logoUrl: string | null;
  /** True once the initial resolution attempt has settled (success OR failure) — mirrors SessionProvider's own `ready` gate. */
  ready: boolean;
  /** Re-resolves branding NOW, without waiting for the next auth-state change — call after a settings-page mutation (save/upload/rebrand toggle) so the sidebar/footer reflect it immediately, not just after the next login. */
  refresh: () => void;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  logoUrl: null,
  ready: false,
  refresh: () => {},
});

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}

/**
 * Resolves and applies the caller's tenant branding — mounted at the ROOT
 * layout, INSIDE `<AuthProvider>` (see app/layout.tsx), so both the
 * pre-login screen and every authenticated page get it. See
 * docs/conventions/white-label.md.
 *
 * **Re-fetches whenever `AuthContext`'s `user` changes**, not just once on
 * mount — this is what makes header-strategy tenant resolution (the
 * fallback used whenever no per-tenant subdomain is configured, e.g. this
 * app's own Playwright suite/local dev — see tenant.ts) work correctly
 * here: on a genuinely fresh visit, no tenant slug is stored yet (nothing
 * has been typed into the login form's Workspace field), so the VERY
 * FIRST resolution attempt (on mount, pre-login) legitimately fails and
 * falls back to the plain defaults — but `AuthContext.login()` calls
 * `setStoredTenantSlug()` BEFORE it ever updates `user`, so the effect
 * re-running on that transition is guaranteed to see the now-known slug
 * and resolve the REAL branding, not stay stuck on the stale pre-login
 * default forever. Subdomain-strategy deployments don't depend on this at
 * all (the tenant is resolvable from the hostname alone, pre-login) — this
 * is what makes the header-strategy case work too, not what the mechanism
 * exists for.
 */
export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [branding, setBranding] = useState<PublicBranding>(DEFAULT_BRANDING);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  const refresh = useCallback(() => setRefreshCounter((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];

    async function load() {
      try {
        const resolved = await getPublicBranding();
        if (cancelled) return;
        setBranding(resolved);
        document.title = resolved.productName;

        if (resolved.hasLogo) {
          const url = await fetchBrandingImage('/branding/logo');
          objectUrls.push(url);
          if (!cancelled) setLogoUrl(url);
        } else if (!cancelled) {
          setLogoUrl(null);
        }
        if (resolved.hasFavicon) {
          const url = await fetchBrandingImage('/branding/favicon');
          objectUrls.push(url);
          if (!cancelled) {
            let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
            if (!link) {
              link = document.createElement('link');
              link.rel = 'icon';
              document.head.appendChild(link);
            }
            link.href = url;
          }
        }
      } catch {
        // No resolvable tenant yet, or the network call otherwise failed —
        // the plain defaults already set above stand. Never throw here:
        // a branding failure must never block the app from rendering.
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `user` (identity change on login/logout) and `refreshCounter` (explicit refresh() calls) are the only two intentional re-fetch triggers; the fetch functions themselves are stable module-level imports.
  }, [user, refreshCounter]);

  return <BrandingContext.Provider value={{ branding, logoUrl, ready, refresh }}>{children}</BrandingContext.Provider>;
}
