import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useI18n } from '../i18n/I18nContext';
import { useAuth } from '../lib/auth/AuthContext';
import { SessionProvider } from '../lib/session/SessionContext';
import { PageSpinner } from '../components/ui/Spinner';
import { LoginScreen } from '../screens/LoginScreen';
import { AppTabs } from './AppTabs';
import { ProfileEditScreen } from '../screens/ProfileEditScreen';
import { LeaveApplyScreen } from '../screens/LeaveApplyScreen';
import { AttendanceRegularizeScreen } from '../screens/AttendanceRegularizeScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { AnnouncementsScreen } from '../screens/AnnouncementsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { colors } from '../theme/tokens';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * The signed-out/signed-in split: an unauthenticated caller only ever sees
 * `Login`; everything else (the tab shell plus every pushed detail screen)
 * lives behind it, wrapped in `<SessionProvider>` so the own-Employee/
 * Country-Pack resolution (see ../lib/session/SessionContext.tsx) only
 * ever runs for a signed-in user, mirroring apps/portal's
 * `(app)/layout.tsx` route-group split.
 */
export function RootNavigator() {
  const { user, loading } = useAuth();
  const { t } = useI18n();

  if (loading) return <PageSpinner />;

  const headerOptions = {
    headerStyle: { backgroundColor: colors.sand[50] },
    headerTintColor: colors.ink[900],
    headerShadowVisible: false,
  } as const;

  if (!user) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Login" component={LoginScreen} />
      </Stack.Navigator>
    );
  }

  return (
    <SessionProvider>
      <Stack.Navigator screenOptions={headerOptions}>
        <Stack.Screen name="Tabs" component={AppTabs} options={{ headerShown: false }} />
        <Stack.Screen name="ProfileEdit" component={ProfileEditScreen} options={{ title: t('profile.editTitle') }} />
        <Stack.Screen name="LeaveApply" component={LeaveApplyScreen} options={{ title: t('leave.applyTitle') }} />
        <Stack.Screen name="AttendanceRegularize" component={AttendanceRegularizeScreen} options={{ title: t('attendance.regularizeTitle') }} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: t('notifications.title') }} />
        <Stack.Screen name="Announcements" component={AnnouncementsScreen} options={{ title: t('announcements.title') }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: t('settings.title') }} />
      </Stack.Navigator>
    </SessionProvider>
  );
}
