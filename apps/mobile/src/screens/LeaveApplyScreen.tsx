import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useI18n } from '../i18n/I18nContext';
import { submitLeaveRequest } from '../lib/api/leave';
import { LEAVE_TYPES, LeaveType } from '../lib/api/types';
import { ApiError } from '../lib/api/client';
import { Screen } from '../components/ui/Screen';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Alert } from '../components/ui/Alert';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';

export function LeaveApplyScreen() {
  const { t } = useI18n();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [leaveType, setLeaveType] = useState<LeaveType>('ANNUAL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await submitLeaveRequest({ leaveType, startDate, endDate, reason: reason || undefined });
      setSuccess(true);
      setTimeout(() => navigation.goBack(), 900);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = startDate.length > 0 && endDate.length > 0;

  return (
    <Screen>
      <Text style={styles.title}>{t('leave.applyTitle')}</Text>

      <View style={styles.field}>
        <Text style={styles.label}>{t('leave.leaveType')}</Text>
        <View style={styles.pillRow}>
          {LEAVE_TYPES.map((lt) => (
            <Pressable
              key={lt}
              onPress={() => setLeaveType(lt)}
              style={[styles.pill, leaveType === lt && styles.pillActive]}
            >
              <Text style={[styles.pillText, leaveType === lt && styles.pillTextActive]}>{t(`leave.type.${lt}`)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <TextField label={t('leave.startDate')} value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" />
      <TextField label={t('leave.endDate')} value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" />
      <TextField label={`${t('common.reason')} (${t('common.optional')})`} value={reason} onChangeText={setReason} multiline numberOfLines={3} />

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{t('leave.submitted')}</Alert>}

      <Button title={t('leave.submit')} onPress={handleSubmit} loading={submitting} disabled={!canSubmit} fullWidth />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  field: { gap: spacing.xs },
  label: { ...typography.label, color: colors.ink[600] },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    borderWidth: 1,
    borderColor: colors.ink[200],
    borderRadius: radius.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.white,
  },
  pillActive: { backgroundColor: colors.brand[600], borderColor: colors.brand[600] },
  pillText: { ...typography.small, color: colors.ink[600] },
  pillTextActive: { color: colors.white, fontWeight: '600' },
});
