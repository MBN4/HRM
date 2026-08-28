import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { CalendarDays, Clock, Home, MoreHorizontal, User } from 'lucide-react-native';
import { useI18n } from '../i18n/I18nContext';
import { HomeScreen } from '../screens/HomeScreen';
import { LeaveScreen } from '../screens/LeaveScreen';
import { AttendanceScreen } from '../screens/AttendanceScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { colors } from '../theme/tokens';
import type { TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();

/**
 * ESS-only bottom-tab shell — no Approvals/Team/Org-chart tabs (MSS is out
 * of mobile's scope for this step, see /CLAUDE.md § 6 "1.4+" and the task
 * brief's own scope line). A simple stack + bottom-tab-for-home combo, per
 * the brief's own "your call, keep it simple and coherent" latitude.
 */
export function AppTabs() {
  const { t } = useI18n();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand[600],
        tabBarInactiveTintColor: colors.ink[400],
        tabBarStyle: { borderTopColor: colors.ink[100] },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: t('nav.dashboard'), tabBarIcon: ({ color, size }) => <Home color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Leave"
        component={LeaveScreen}
        options={{ title: t('nav.leave'), tabBarIcon: ({ color, size }) => <CalendarDays color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Attendance"
        component={AttendanceScreen}
        options={{ title: t('nav.attendance'), tabBarIcon: ({ color, size }) => <Clock color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ title: t('nav.profile'), tabBarIcon: ({ color, size }) => <User color={color} size={size} /> }}
      />
      <Tab.Screen
        name="More"
        component={MoreScreen}
        options={{ title: t('common.viewAll'), tabBarIcon: ({ color, size }) => <MoreHorizontal color={color} size={size} /> }}
      />
    </Tab.Navigator>
  );
}
