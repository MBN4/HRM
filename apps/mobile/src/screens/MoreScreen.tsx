import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Bell, ChevronRight, Megaphone, Settings as SettingsIcon } from 'lucide-react-native';
import { useI18n } from '../i18n/I18nContext';
import { Screen } from '../components/ui/Screen';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';

/** The bottom-tab landing point for everything that doesn't earn its own tab — mirrors what apps/portal's sidebar lists beyond Dashboard/Leave/Attendance/Profile, minus MSS-only entries (Approvals/Team/Org chart — see the task brief's "ESS + clock-in + push, not MSS" scope). */
export function MoreScreen() {
  const { t } = useI18n();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const items: { key: keyof RootStackParamList; icon: React.ReactNode; label: string }[] = [
    { key: 'Notifications', icon: <Bell size={20} color={colors.ink[500]} />, label: t('nav.notifications') },
    { key: 'Announcements', icon: <Megaphone size={20} color={colors.ink[500]} />, label: t('nav.announcements') },
    { key: 'Settings', icon: <SettingsIcon size={20} color={colors.ink[500]} />, label: t('nav.settings') },
  ];

  return (
    <Screen scroll={false}>
      <View style={styles.list}>
        {items.map((item) => (
          <Pressable key={item.key} style={styles.row} onPress={() => navigation.navigate(item.key as never)}>
            <View style={styles.rowLeft}>
              {item.icon}
              <Text style={styles.label}>{item.label}</Text>
            </View>
            <ChevronRight size={18} color={colors.ink[300]} />
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.white, borderRadius: radius.lg, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.ink[100],
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  label: { ...typography.body, color: colors.ink[800] },
});
