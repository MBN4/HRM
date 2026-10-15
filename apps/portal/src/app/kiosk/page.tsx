import { KioskScreen } from '../../components/kiosk/KioskScreen';

/**
 * The kiosk terminal (step 11.1). Deliberately OUTSIDE the `(app)` route group: it must not inherit the
 * authenticated shell (sidebar/topbar/session gate) — a kiosk is a single-purpose device screen that runs on
 * its own device token and exposes nothing else. See docs/conventions/kiosk.md.
 */
export const metadata = { title: 'Kiosk' };

export default function KioskPage() {
  return <KioskScreen />;
}
