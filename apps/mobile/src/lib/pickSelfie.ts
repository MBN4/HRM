import * as ImagePicker from 'expo-image-picker';
import type { MobilePhoto } from './api/attendance';

/**
 * "Capture a photo of yourself clocking in" — front camera preferred, per
 * the task brief. `expo-image-picker`'s `launchCameraAsync` covers both
 * platforms with one call (no separate `expo-camera` view/permission flow
 * needed for a single still capture); `cameraType: 'front'` is a hint, not
 * a guarantee — some devices/OS camera UIs let the user flip it anyway,
 * which is fine, this is a convenience default, not an enforced constraint.
 * Returns `null` on permission denial or user cancellation — same
 * "optional, never blocks the flow" posture attendance.md documents for
 * the whole selfie-capture feature (`clockInPhotoKey`/`clockOutPhotoKey`
 * are nullable columns; a clock-in/out with no photo is a normal case).
 */
export async function captureSelfie(): Promise<MobilePhoto | null> {
  try {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) {
      return null;
    }
    const result = await ImagePicker.launchCameraAsync({
      cameraType: ImagePicker.CameraType.front,
      mediaTypes: ['images'],
      quality: 0.6,
      allowsEditing: false,
    });
    if (result.canceled) return null;
    if (result.assets.length === 0) return null;
    const asset = result.assets[0];
    return {
      uri: asset.uri,
      name: asset.fileName ?? `selfie-${Date.now()}.jpg`,
      type: asset.mimeType ?? 'image/jpeg',
    };
  } catch {
    return null;
  }
}
