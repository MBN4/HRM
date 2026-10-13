import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Moon } from 'lucide-react-native';
import { useI18n } from '../i18n/I18nContext';
import { useSession } from '../lib/session/SessionContext';
import { useAsync } from '../lib/useAsync';
import { getMySchedule, type MyScheduleDay } from '../lib/api/scheduling';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Alert } from '../components/ui/Alert';
import { EmptyState } from '../components/ui/EmptyState';
import { PageSpinner } from '../components/ui/Spinner';
import { colors, spacing, typography } from '../theme/tokens';

const FALLBACK_COLOR = '#2e9e7e';

/** "Mon, Oct 13" from a plain YYYY-MM-DD — formatted in UTC so the device timezone can't shift the day. */
function formatDay(ymd: string, locale: string): string {
  return new Intl.DateTimeFormat(locale.replace('_', '-'), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));
}

function DayRow({ day, today, locale }: { day: MyScheduleDay; today: string; locale: string }) {
  const { t } = useI18n();
  const shift = day.shift;
  const overnight = !!shift && shift.endTime <= shift.startTime;
  const muted = day.kind === 'WEEKEND' || day.kind === 'HOLIDAY' || day.kind === 'DAY_OFF';

  return (
    <View style={[styles.row, day.date === today && styles.today]}>
      <View style={styles.dayCol}>
        <Text style={styles.day}>{formatDay(day.date, locale)}</Text>
        {day.date === today && <Text style={styles.todayLabel}>{t('common.today')}</Text>}
      </View>
      <View style={styles.main}>
        {day.kind === 'SHIFT' && shift ? (
          <View style={styles.shiftBlock}>
            <View style={[styles.swatch, { backgroundColor: shift.color ?? FALLBACK_COLOR }]} />
            <View style={styles.shiftText}>
              <Text style={styles.shiftName}>{shift.name}</Text>
              <View style={styles.timeRow}>
                <Text style={styles.time}>
                  {shift.startTime}–{shift.endTime}
                </Text>
                {overnight && (
                  <View style={styles.overnight} accessibilityLabel={t('schedule.overnight')}>
                    <Moon size={12} color={colors.ink[600]} />
                    <Text style={styles.time}>+1</Text>
                  </View>
                )}
              </View>
            </View>
            {day.via && <Badge label={t(`schedule.via.${day.via}`)} tone={day.via === 'ROSTER' ? 'success' : 'neutral'} />}
          </View>
        ) : day.kind === 'DEFAULT_HOURS' ? (
          <Text style={styles.text}>{t('schedule.defaultHours', { start: day.startTime ?? '—', hours: day.requiredHours ?? 0 })}</Text>
        ) : (
          <Text style={[styles.text, muted && styles.mutedText]}>{t(`schedule.kind.${day.kind}`)}</Text>
        )}
        {day.swap && <Badge label={t(`schedule.swap.status.${day.swap.status}`)} tone="warning" />}
      </View>
    </View>
  );
}

/** Step 8.2 — read-only "My schedule": the next ~14 days from `GET /scheduling/my-schedule`. Requesting a swap / approving one stays on the portal. */
export function ScheduleScreen() {
  const { t, locale } = useI18n();
  const { employeeLoading } = useSession();
  const { data, loading, error, reload } = useAsync(() => getMySchedule(), []);

  if (employeeLoading || (loading && !data)) return <PageSpinner />;

  return (
    <Screen onRefresh={reload}>
      <Text style={styles.title}>{t('schedule.title')}</Text>
      {error && <Alert tone="error">{error}</Alert>}
      {data && (
        <>
          <Text style={styles.sub}>{t('schedule.timezone', { tz: data.timezone })}</Text>
          {data.days.length === 0 ? (
            <EmptyState title={t('common.noData')} />
          ) : (
            <Card>
              <CardBody>
                {data.days.map((d) => (
                  <DayRow key={d.date} day={d} today={data.today} locale={locale} />
                ))}
              </CardBody>
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  sub: { ...typography.body, color: colors.ink[500] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.ink[100],
  },
  today: { backgroundColor: colors.brand[50] },
  dayCol: { width: 92 },
  day: { ...typography.body, color: colors.ink[900], fontWeight: '600' },
  todayLabel: { ...typography.label, color: colors.brand[700] },
  main: { flex: 1, gap: spacing.xs },
  shiftBlock: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  swatch: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  shiftText: { flex: 1 },
  shiftName: { ...typography.body, color: colors.ink[900], fontWeight: '600' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  time: { ...typography.body, color: colors.ink[600], fontSize: 13 },
  overnight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  text: { ...typography.body, color: colors.ink[800] },
  mutedText: { color: colors.ink[500] },
});
