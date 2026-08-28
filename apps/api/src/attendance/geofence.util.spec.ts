import { haversineDistanceMeters, isWithinGeofence } from './geofence.util';

describe('geofence.util', () => {
  describe('haversineDistanceMeters', () => {
    it('returns ~0 for the same point', () => {
      expect(haversineDistanceMeters(25.276987, 51.520008, 25.276987, 51.520008)).toBeCloseTo(0, 3);
    });

    it('computes a real-world distance within a reasonable tolerance (Doha to a point ~1.11km north)', () => {
      // 0.01 degrees of latitude is ~1.11km everywhere on Earth.
      const distance = haversineDistanceMeters(25.2769, 51.52, 25.2869, 51.52);
      expect(distance).toBeGreaterThan(1_000);
      expect(distance).toBeLessThan(1_200);
    });
  });

  describe('isWithinGeofence', () => {
    it('is OFF (always true) when the branch has no geofence configured at all', () => {
      const config = { geofenceLat: null, geofenceLong: null, geofenceRadiusMeters: null };
      expect(isWithinGeofence(config, 0, 0)).toBe(true);
      expect(isWithinGeofence(config, 89, 179)).toBe(true);
    });

    it('accepts a point inside the configured radius', () => {
      const config = { geofenceLat: 25.2769, geofenceLong: 51.52, geofenceRadiusMeters: 200 };
      expect(isWithinGeofence(config, 25.2769, 51.52)).toBe(true);
    });

    it('rejects a point outside the configured radius', () => {
      const config = { geofenceLat: 25.2769, geofenceLong: 51.52, geofenceRadiusMeters: 100 };
      // ~1.11km away — well outside a 100m radius.
      expect(isWithinGeofence(config, 25.2869, 51.52)).toBe(false);
    });
  });
});
