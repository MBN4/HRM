import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Megaphone } from 'lucide-react-native';
import { useI18n } from '../i18n/I18nContext';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody } from '../components/ui/Card';
import { colors, spacing, typography } from '../theme/tokens';

/**
 * A deliberate SEAM, not a feature — mirrors
 * apps/portal/src/app/(app)/announcements/page.tsx exactly: the real
 * announcements module is Phase 3 (see /CLAUDE.md § 6). This screen exists
 * now so its place in the product is established, with no backend behind
 * it.
 */
export function AnnouncementsScreen() {
  const { t } = useI18n();
  return (
    <Screen>
      <Text style={styles.title}>{t('announcements.title')}</Text>
      <Card>
        <CardBody style={styles.body}>
          <Megaphone size={32} color={colors.ink[300]} />
          <Text style={styles.text}>{t('announcements.comingSoon')}</Text>
        </CardBody>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  body: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  text: { ...typography.body, color: colors.ink[500], textAlign: 'center', maxWidth: 280 },
});
