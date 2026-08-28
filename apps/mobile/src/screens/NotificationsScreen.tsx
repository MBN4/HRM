import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../i18n/I18nContext';
import { useAsync } from '../lib/useAsync';
import { listNotifications, markNotificationRead } from '../lib/api/notifications';
import { Screen } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/EmptyState';
import { PageSpinner } from '../components/ui/Spinner';
import { formatDateTime } from '../lib/format';
import { colors, radius, spacing, typography } from '../theme/tokens';

export function NotificationsScreen() {
  const { t, locale } = useI18n();
  const { data: notifications, loading, reload } = useAsync(() => listNotifications(), []);

  async function handleMarkRead(deliveryId: string) {
    try {
      await markNotificationRead(deliveryId);
      reload();
    } catch {
      // Best-effort — reload() re-derives the true state either way.
    }
  }

  if (loading) return <PageSpinner />;

  return (
    <Screen onRefresh={reload}>
      <Text style={styles.title}>{t('notifications.title')}</Text>

      {!notifications || notifications.length === 0 ? (
        <EmptyState title={t('notifications.empty')} />
      ) : (
        <View style={styles.list}>
          {notifications.map((n) => {
            const isRead = Boolean(n.delivery.readAt);
            return (
              <View key={n.id} style={[styles.item, !isRead && styles.itemUnread]}>
                <Text style={styles.subject}>{n.delivery.renderedSubject ?? n.eventType}</Text>
                {n.delivery.renderedBody ? <Text style={styles.body}>{n.delivery.renderedBody}</Text> : null}
                <View style={styles.footer}>
                  <Text style={styles.timestamp}>{formatDateTime(n.createdAt, locale)}</Text>
                  {!isRead && (
                    <Pressable onPress={() => handleMarkRead(n.delivery.id)}>
                      <Text style={styles.markRead}>{t('notifications.markRead')}</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  list: { gap: spacing.sm },
  item: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink[100],
    gap: spacing.xs,
  },
  itemUnread: { borderColor: colors.brand[200], backgroundColor: colors.brand[50] },
  subject: { ...typography.body, color: colors.ink[900], fontWeight: '600' },
  body: { ...typography.small, color: colors.ink[600] },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.xs },
  timestamp: { ...typography.small, color: colors.ink[400] },
  markRead: { ...typography.small, color: colors.brand[700], fontWeight: '600' },
});
