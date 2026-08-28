import * as Location from 'expo-location';

export interface Coordinates {
  lat: number;
  long: number;
}

/**
 * Mirrors apps/portal/src/lib/geolocation.ts's contract exactly: resolves
 * to `null` (never rejects) when location is unavailable OR the user
 * denies the permission prompt — callers proceed WITHOUT coordinates and
 * let the API's geofence check 400 with its own real error message if the
 * employee's branch actually requires them (see
 * docs/conventions/attendance.md's "Geo-fencing is per-branch, opt-in").
 * Client-side geofence logic is deliberately never implemented — the
 * server is the one source of truth for whether a branch requires this.
 */
export async function getCurrentCoordinates(): Promise<Coordinates | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== Location.PermissionStatus.GRANTED) {
      return null;
    }
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: position.coords.latitude, long: position.coords.longitude };
  } catch {
    return null;
  }
}
