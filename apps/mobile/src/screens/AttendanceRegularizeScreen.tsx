import React, { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useI18n } from '../i18n/I18nContext';
import { submitRegularization } from '../lib/api/attendance';
import { ApiError } from '../lib/api/client';
import { Screen } from '../components/ui/Screen';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Alert } from '../components/ui/Alert';
import { colors, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';

export function AttendanceRegularizeScreen() {
  const { t } = useI18n();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [workDate, setWorkDate] = useState('');
  const [requestedClockInAt, setRequestedClockInAt] = useState('');
  const [requestedClockOutAt, setRequestedClockOutAt] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await submitRegularization({
        workDate,
        requestedClockInAt: requestedClockInAt ? new Date(requestedClockInAt).toISOString() : undefined,
        requestedClockOutAt: requestedClockOutAt ? new Date(requestedClockOutAt).toISOString() : undefined,
        reason,
      });
      setSuccess(true);
      setTimeout(() => navigation.goBack(), 900);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = workDate.length > 0 && reason.length > 0;

  return (
    <Screen>
      <Text style={styles.title}>{t('attendance.regularizeTitle')}</Text>

      <TextField label={t('attendance.workDate')} value={workDate} onChangeText={setWorkDate} placeholder="YYYY-MM-DD" />
      <TextField
        label={t('attendance.requestedClockIn')}
        value={requestedClockInAt}
        onChangeText={setRequestedClockInAt}
        placeholder="YYYY-MM-DD HH:mm"
      />
      <TextField
        label={t('attendance.requestedClockOut')}
        value={requestedClockOutAt}
        onChangeText={setRequestedClockOutAt}
        placeholder="YYYY-MM-DD HH:mm"
      />
      <TextField label={t('common.reason')} value={reason} onChangeText={setReason} multiline numberOfLines={3} />

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{t('attendance.regularizationSubmitted')}</Alert>}

      <Button title={t('common.submit')} onPress={handleSubmit} loading={submitting} disabled={!canSubmit} fullWidth />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
});
