import { useEffect, useRef } from 'react';
import { I18nManager } from 'react-native';
import * as Updates from 'expo-updates';

/**
 * React Native's RTL story is fundamentally different from the web
 * portal's: `apps/portal`'s `I18nProvider` flips `<html dir>` live, an
 * instant re-render with no reload (see
 * docs/conventions/i18n-timezone-rtl.md). React Native has no DOM `dir`
 * attribute — layout mirroring is a NATIVE property
 * (`I18nManager.isRTL`) baked into how the native view tree lays out on
 * THIS launch, and `I18nManager.forceRTL()` only takes effect from the
 * NEXT app launch onward. There is no live, instant flip available here;
 * this is a deliberate, accepted platform difference, not a bug to
 * engineer around.
 *
 * So: on every resolution of the AUTHORITATIVE `rtl` signal (the resolved
 * Country Pack's `locale.rtl` — see src/lib/session/SessionContext.tsx —
 * falling back to a bare language-code guess, `isRtlLanguage`, only when
 * there's no linked Employee/pack to resolve at all), if it disagrees with
 * `I18nManager.isRTL` (this launch's current native layout direction), we
 * flip the native flag and force ONE app reload so the NEXT launch renders
 * mirrored. `Updates.reloadAsync()` is a no-op-with-warning in an
 * Expo-Go/dev-client session with no OTA update channel configured (this
 * scaffold's dev-only state) — swallowed here rather than surfaced, since
 * the alternative (a full JS-level manual "please restart the app"
 * fallback banner) is a UX nicety a future step can add, not a
 * correctness requirement of this step's brief.
 */
export function useRtlSync(rtl: boolean | null): void {
  const appliedRef = useRef(false);

  useEffect(() => {
    if (rtl === null || appliedRef.current) return;
    if (I18nManager.isRTL === rtl) return;

    appliedRef.current = true;
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(rtl);
    Updates.reloadAsync().catch(() => {
      // No OTA update channel configured (plain Expo Go / local dev client)
      // — the native forceRTL flag is still set for next natural restart.
    });
  }, [rtl]);
}
