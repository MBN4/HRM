import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Megaphone } from 'lucide-react-native';
import { useI18n } from '../i18n/I18nContext';
import { useSession } from '../lib/session/SessionContext';
import { useAsync } from '../lib/useAsync';
import { getLeaveBalances } from '../lib/api/leave';
import { listNotifications } from '../lib/api/notifications';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody, CardHeader, CardTitle } from '../components/ui/Card';
import { ClockWidget } from '../components/attendance/ClockWidget';
import { EmptyState } from '../components/ui/EmptyState';
import { formatDateTime } from '../lib/format';
import { colors, spacing, typography } from '../theme/tokens';

export function HomeScreen() {
  const { t, locale } = useI18n();
  const { employee, employeeLoading } = useSession();

  const { data: balances, reload: reloadBalances } = useAsync(
    () => (employee ? getLeaveBalances({ employeeId: employee.id }) : Promise.resolve([])),
    [employee?.id],
  );
  const { data: notifications, reload: reloadNotifications } = useAsync(() => listNotifications(), []);

  return (
    <Screen
      onRefresh={() => {
        reloadBalances();
        reloadNotifications();
      }}
    >
      <Text style={styles.greeting}>{t('dashboard.greeting', { name: employee ? employee.firstName : '' })}</Text>

      {!employeeLoading && !employee && (
        <Card>
          <CardBody>
            <Text style={styles.muted}>{t('dashboard.noEmployeeProfile')}</Text>
          </CardBody>
        </Card>
      )}

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
          <CardTitle>{t('dashboard.leaveBalance.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!balances || balances.length === 0 ? (
            <Text style={styles.muted}>{t('common.noData')}</Text>
          ) : (
            <View style={styles.list}>
              {balances.map((b) => (
                <View key={b.leaveType} style={styles.listRow}>
                  <Text style={styles.rowLabel}>{t(`leave.type.${b.leaveType}`)}</Text>
                  <Text style={styles.rowValue}>{b.availableDays}</Text>
                </View>
              ))}
            </View>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.notifications.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!notifications || notifications.length === 0 ? (
            <EmptyState title={t('notifications.empty')} />
          ) : (
            <View style={styles.list}>
              {notifications.slice(0, 5).map((n) => (
                <View key={n.id} style={styles.notificationRow}>
                  <Text style={styles.rowLabel} numberOfLines={2}>
                    {n.delivery.renderedSubject ?? n.eventType}
                  </Text>
                  <Text style={styles.timestamp}>{formatDateTime(n.createdAt, locale)}</Text>
                </View>
              ))}
            </View>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.announcements.title')}</CardTitle>
        </CardHeader>
        <CardBody style={styles.announcementsBody}>
          <Megaphone size={24} color={colors.ink[300]} />
          <Text style={styles.muted}>{t('announcements.comingSoon')}</Text>
        </CardBody>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { ...typography.title, color: colors.ink[900] },
  muted: { ...typography.small, color: colors.ink[400] },
  list: { gap: spacing.sm },
  listRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { ...typography.body, color: colors.ink[600], flex: 1 },
  rowValue: { ...typography.heading, color: colors.ink[900] },
  notificationRow: { paddingVertical: spacing.xs, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.ink[100] },
  timestamp: { ...typography.small, color: colors.ink[400] },
  announcementsBody: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
});
