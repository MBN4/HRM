import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { apiSetPushToken } from './api/auth';

/**
 * The client half of "push notifications wired to the 0.8 hub" — see
 * apps/api/src/auth/auth.controller.ts's new `POST /auth/push-token` route
 * and `apps/api/src/notifications/providers/log-push.provider.ts`. Be
 * precise about what this step actually delivers: this file gets an Expo
 * push token onto the device and REGISTERS it against `User.pushToken`
 * (a real, already-wired backend column/route) so the 0.8 notification
 * hub's PUSH channel dispatch has a real `to` address to read instead of
 * its old placeholder. Actual push DELIVERY still goes through
 * `LogPushProvider` (dev/log-only) — swapping in a provider that really
 * calls Expo's push API is a separate future step (one DI binding change
 * server-side, the same provider-seam pattern 0.8 already established),
 * deliberately NOT attempted here.
 */

function readProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** Requests notification permission (if not already granted) and returns a fresh Expo push token, or `null` if permission is denied or this is a simulator/emulator (no real push capability) or the request otherwise fails. Never throws. */
export async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) {
    // Simulators/emulators can't receive real push notifications — Expo's
    // own guidance is to skip token registration entirely rather than let
    // `getExpoPushTokenAsync` fail confusingly.
    return null;
  }
  try {
    const existing = await Notifications.getPermissionsAsync();
    let finalStatus = existing.status;
    if (finalStatus !== Notifications.PermissionStatus.GRANTED) {
      const requested = await Notifications.requestPermissionsAsync();
      finalStatus = requested.status;
    }
    if (finalStatus !== Notifications.PermissionStatus.GRANTED) return null;

    const projectId = readProjectId();
    const response = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return response.data;
  } catch {
    return null;
  }
}

/** Fetches a push token and registers it with the backend — called once after a successful login and again whenever the OS reports the token rolled (see subscribeToPushTokenRotation). Best-effort: a failure here never blocks or breaks the calling flow. */
export async function registerPushToken(): Promise<void> {
  const token = await getExpoPushToken();
  if (!token) return;
  try {
    await apiSetPushToken(token);
  } catch {
    // Best-effort — the app still works without push; the next successful
    // registration attempt (next login, next rotation) will retry.
  }
}

/** Deregisters this device's push token on logout, per the task brief ("On logout, POST { pushToken: null } to deregister"). Best-effort — logout itself must never be blocked by this. */
export async function deregisterPushToken(): Promise<void> {
  try {
    await apiSetPushToken(null);
  } catch {
    // Best-effort — logout proceeds regardless.
  }
}

/** In rare cases the push service rolls a device's token while the app is running (see expo-notifications' own docs on `addPushTokenListener`). Re-registers with the backend when that happens so it never has a stale token. */
export function subscribeToPushTokenRotation(): { remove: () => void } {
  return Notifications.addPushTokenListener(() => {
    registerPushToken().catch(() => {
      // Best-effort, see registerPushToken's own doc comment.
    });
  });
}

/**
 * Foreground notification presentation policy — without this, iOS/Android
 * both suppress a notification's banner/sound while the app that owns it
 * is in the foreground by default. Shown once at app start (see App.tsx).
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}
