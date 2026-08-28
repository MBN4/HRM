import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useI18n } from '../i18n/I18nContext';
import { useSession } from '../lib/session/SessionContext';
import { useAsync } from '../lib/useAsync';
import { getLeaveBalances, listLeaveRequests } from '../lib/api/leave';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge, BadgeTone } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { PageSpinner } from '../components/ui/Spinner';
import { formatDate } from '../lib/format';
import { colors, spacing, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';
import type { LeaveRequestStatus } from '../lib/api/types';

const statusTone: Record<LeaveRequestStatus, BadgeTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELED: 'neutral',
};

export function LeaveScreen() {
  const { t, locale } = useI18n();
  const { employee, employeeLoading } = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const {
    data: balances,
    loading: balancesLoading,
    reload: reloadBalances,
  } = useAsync(() => (employee ? getLeaveBalances({ employeeId: employee.id }) : Promise.resolve([])), [employee?.id]);
  const {
    data: requests,
    loading: requestsLoading,
    reload: reloadRequests,
  } = useAsync(() => listLeaveRequests(), [employee?.id]);

  if (employeeLoading) return <PageSpinner />;

  return (
    <Screen
      onRefresh={() => {
        reloadBalances();
        reloadRequests();
      }}
    >
      <View style={styles.headerRow}>
        <Text style={styles.title}>{t('leave.title')}</Text>
        <Button title={t('leave.apply')} onPress={() => navigation.navigate('LeaveApply')} />
      </View>

      <Card>
        <CardHeader>
          <CardTitle>{t('leave.balances')}</CardTitle>
        </CardHeader>
        <CardBody>
          {balancesLoading ? (
            <PageSpinner />
          ) : !balances || balances.length === 0 ? (
            <Text style={styles.muted}>{t('common.noData')}</Text>
          ) : (
            <View style={styles.list}>
              {balances.map((b) => (
                <View key={b.leaveType} style={styles.balanceRow}>
                  <Text style={styles.rowLabel}>{t(`leave.type.${b.leaveType}`)}</Text>
                  <View style={styles.balanceStats}>
                    <Text style={styles.balanceStat}>
                      {t('leave.available')}: <Text style={styles.balanceStatValue}>{b.availableDays}</Text>
                    </Text>
                    <Text style={styles.balanceStat}>
                      {t('leave.entitled')}: <Text style={styles.balanceStatValue}>{b.entitledDays}</Text>
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('leave.history')}</CardTitle>
        </CardHeader>
        <CardBody>
          {requestsLoading ? (
            <PageSpinner />
          ) : !requests || requests.length === 0 ? (
            <EmptyState title={t('leave.noRequests')} />
          ) : (
            <View style={styles.list}>
              {requests.map((r) => (
                <View key={r.id} style={styles.requestRow}>
                  <View style={styles.requestInfo}>
                    <Text style={styles.rowLabel}>{t(`leave.type.${r.leaveType}`)}</Text>
                    <Text style={styles.muted}>
                      {formatDate(r.startDate, locale)} – {formatDate(r.endDate, locale)} · {t('leave.days', { count: r.days })}
                    </Text>
                  </View>
                  <Badge label={t(`leave.status.${r.status}`)} tone={statusTone[r.status]} />
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
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { ...typography.title, color: colors.ink[900] },
  muted: { ...typography.small, color: colors.ink[400] },
  list: { gap: spacing.md },
  balanceRow: { gap: 4 },
  rowLabel: { ...typography.body, color: colors.ink[900], fontWeight: '600' },
  balanceStats: { flexDirection: 'row', gap: spacing.lg },
  balanceStat: { ...typography.small, color: colors.ink[500] },
  balanceStatValue: { color: colors.ink[900], fontWeight: '700' },
  requestRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.ink[100],
    gap: spacing.sm,
  },
  requestInfo: { flex: 1, gap: 2 },
});
