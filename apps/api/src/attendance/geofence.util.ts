const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two lat/long points, in meters (haversine formula). */
export function haversineDistanceMeters(lat1: number, long1: number, lat2: number, long2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLong = toRadians(long2 - long1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLong / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export interface GeofenceConfig {
  geofenceLat: number | null;
  geofenceLong: number | null;
  geofenceRadiusMeters: number | null;
}

/**
 * `null` = geo-fencing is OFF for this branch (the default) — every clock-in
 * is accepted regardless of location. When configured, a clock-in WITHOUT
 * coordinates is rejected (see AttendanceClockService) — an optional
 * feature per branch, but not optional to satisfy once a branch opts in,
 * or it would have no teeth. See docs/conventions/attendance.md.
 */
export function isWithinGeofence(config: GeofenceConfig, lat: number, long: number): boolean {
  if (config.geofenceLat === null || config.geofenceLong === null || config.geofenceRadiusMeters === null) {
    return true;
  }
  return haversineDistanceMeters(config.geofenceLat, config.geofenceLong, lat, long) <= config.geofenceRadiusMeters;
}
