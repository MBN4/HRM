import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Camera, LogIn, LogOut } from 'lucide-react-native';
import { useI18n } from '../../i18n/I18nContext';
import { clockIn, clockOut, listAttendanceRecords, MobilePhoto } from '../../lib/api/attendance';
import { getCurrentCoordinates } from '../../lib/geolocation';
import { captureSelfie } from '../../lib/pickSelfie';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { formatTime } from '../../lib/format';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';
import { colors, spacing, typography } from '../../theme/tokens';

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * THE core mobile feature (see task brief) — mirrors
 * apps/portal/src/components/attendance/ClockWidget.tsx's shape
 * (open-record detection, optional geo/photo capture, success/error
 * banners) with RN-native building blocks: `expo-location` instead of the
 * browser Geolocation API, `expo-image-picker`'s front camera instead of
 * an `<input capture>` shim, and `source: 'MOBILE'` instead of `'WEB'` —
 * the entire reason that `AttendanceSource` enum value exists (see
 * docs/conventions/attendance.md). Client-side geofence logic is
 * deliberately never implemented; a branch that requires coordinates and
 * didn't get them fails server-side with the API's own real error
 * message, surfaced here as-is.
 */
export function ClockWidget({ locale }: { locale: string }) {
  const { t } = useI18n();
  const {
    data: records,
    loading,
    reload,
  } = useAsync(() => listAttendanceRecords({ from: dateOffset(-1), to: dateOffset(1) }), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [photo, setPhoto] = useState<MobilePhoto | null>(null);

  const openRecord = records?.find((r) => r.status === 'OPEN') ?? null;

  async function handleTakePhoto() {
    const captured = await captureSelfie();
    if (captured) setPhoto(captured);
  }

  async function handleClock(direction: 'in' | 'out') {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const coords = await getCurrentCoordinates();
      const action = direction === 'in' ? clockIn : clockOut;
      await action({ source: 'MOBILE', lat: coords?.lat, long: coords?.long, photo });
      setSuccess(direction === 'in' ? t('attendance.clockInSuccess') : t('attendance.clockOutSuccess'));
      setPhoto(null);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageSpinner />;

  return (
    <View style={styles.container}>
      {openRecord ? (
        <Text style={styles.status}>{t('attendance.clockedInSince', { time: formatTime(openRecord.clockInAt, locale) })}</Text>
      ) : (
        <Text style={styles.statusMuted}>{t('attendance.notClockedIn')}</Text>
      )}

      <View style={styles.row}>
        <View style={styles.buttonFlex}>
          <Button
            title={openRecord ? t('attendance.clockOut') : t('attendance.clockIn')}
            onPress={() => handleClock(openRecord ? 'out' : 'in')}
            loading={busy}
            variant={openRecord ? 'danger' : 'primary'}
            icon={openRecord ? <LogOut size={16} color={colors.white} /> : <LogIn size={16} color={colors.white} />}
            fullWidth
          />
        </View>
        <Button
          title=""
          onPress={handleTakePhoto}
          variant="secondary"
          icon={<Camera size={18} color={photo ? colors.brand[700] : colors.ink[400]} />}
        />
      </View>
      {photo && <Text style={styles.photoHint}>{t('attendance.photo')} ✓</Text>}

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  status: { ...typography.small, color: colors.ink[600] },
  statusMuted: { ...typography.small, color: colors.ink[400] },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  buttonFlex: { flex: 1 },
  photoHint: { ...typography.small, color: colors.brand[600] },
});
