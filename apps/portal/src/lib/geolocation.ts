export interface Coordinates {
  lat: number;
  long: number;
}

/** Resolves to `null` (rather than rejecting) when geolocation is unavailable or the user denies it — callers should proceed without coordinates and let the API 400 if the branch actually requires them. */
export function getCurrentCoordinates(timeoutMs = 8000): Promise<Coordinates | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, long: position.coords.longitude }),
      () => resolve(null),
      { timeout: timeoutMs, enableHighAccuracy: true },
    );
  });
}
