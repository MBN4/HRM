import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useI18n } from '../i18n/I18nContext';
import { useSession } from '../lib/session/SessionContext';
import { useAsync } from '../lib/useAsync';
import { listAttendanceRecords, listRegularizations } from '../lib/api/attendance';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody, CardHeader, CardTitle } from '../components/ui/Card';
import { ClockWidget } from '../components/attendance/ClockWidget';
import { Button } from '../components/ui/Button';
import { Badge, BadgeTone } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { PageSpinner } from '../components/ui/Spinner';
import { formatDate, formatMinutesAsHours, formatTime } from '../lib/format';
import { colors, spacing, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';
import type { AttendanceRegularizationStatus } from '../lib/api/types';

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const regularizationTone: Record<AttendanceRegularizationStatus, BadgeTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELED: 'neutral',
};

export function AttendanceScreen() {
  const { t, locale } = useI18n();
  const { employeeLoading } = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const {
    data: records,
    loading: recordsLoading,
    reload: reloadRecords,
  } = useAsync(() => listAttendanceRecords({ from: dateOffset(-30), to: dateOffset(0) }), []);
  const {
    data: regularizations,
    loading: regularizationsLoading,
    reload: reloadRegularizations,
  } = useAsync(() => listRegularizations(), []);

  if (employeeLoading) return <PageSpinner />;

  return (
    <Screen
      onRefresh={() => {
        reloadRecords();
        reloadRegularizations();
      }}
    >
      <Text style={styles.title}>{t('attendance.title')}</Text>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.clockWidget.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ClockWidget locale={locale} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('attendance.history')}</CardTitle>
        </CardHeader>
        <CardBody>
          {recordsLoading ? (
            <PageSpinner />
          ) : !records || records.length === 0 ? (
            <EmptyState title={t('attendance.noRecords')} />
          ) : (
            <View style={styles.list}>
              {records.map((r) => (
                <View key={r.id} style={styles.recordRow}>
                  <View style={styles.recordInfo}>
                    <Text style={styles.rowLabel}>{formatDate(r.workDate, locale)}</Text>
                    <Text style={styles.muted}>
                      {formatTime(r.clockInAt, locale)} – {r.clockOutAt ? formatTime(r.clockOutAt, locale) : t('attendance.status.OPEN')}
                    </Text>
                  </View>
                  <View style={styles.recordStats}>
                    <Text style={styles.statValue}>{formatMinutesAsHours(r.workedMinutes)}</Text>
                    {r.overtimeMinutes > 0 && <Text style={styles.overtimeValue}>+{formatMinutesAsHours(r.overtimeMinutes)} OT</Text>}
                    {r.lateMinutes > 0 && <Text style={styles.lateValue}>{formatMinutesAsHours(r.lateMinutes)} {t('attendance.late').toLowerCase()}</Text>}
                  </View>
                </View>
              ))}
            </View>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('attendance.regularize')}</CardTitle>
          <Button title={t('attendance.regularize')} variant="secondary" onPress={() => navigation.navigate('AttendanceRegularize')} />
        </CardHeader>
        <CardBody>
          {regularizationsLoading ? (
            <PageSpinner />
          ) : !regularizations || regularizations.length === 0 ? (
            <Text style={styles.muted}>{t('common.noData')}</Text>
          ) : (
            <View style={styles.list}>
              {regularizations.map((r) => (
                <View key={r.id} style={styles.recordRow}>
                  <View style={styles.recordInfo}>
                    <Text style={styles.rowLabel}>{formatDate(r.workDate, locale)}</Text>
                    <Text style={styles.muted} numberOfLines={2}>
                      {r.reason}
                    </Text>
                  </View>
                  <Badge label={t(`leave.status.${r.status}`)} tone={regularizationTone[r.status]} />
                </View>
              ))}
            </View>
          )}
        </CardBody>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  muted: { ...typography.small, color: colors.ink[400] },
  list: { gap: spacing.md },
  recordRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.ink[100],
    gap: spacing.sm,
  },
  recordInfo: { flex: 1, gap: 2 },
  rowLabel: { ...typography.body, color: colors.ink[900], fontWeight: '600' },
  recordStats: { alignItems: 'flex-end', gap: 2 },
  statValue: { ...typography.small, color: colors.ink[700], fontWeight: '700' },
  overtimeValue: { ...typography.small, color: colors.amber[600] },
  lateValue: { ...typography.small, color: colors.coral[600] },
});
