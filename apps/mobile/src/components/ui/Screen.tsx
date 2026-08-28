import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing } from '../../theme/tokens';

export interface ScreenProps extends ViewProps {
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * The one screen-level layout wrapper every screen in this app uses —
 * consistent background/padding/safe-area handling, and an optional
 * pull-to-refresh (React Native's native idiom for "reload this screen's
 * data", replacing the web portal's explicit "Try again" button pattern
 * where it makes sense — most list/detail screens here also keep an
 * explicit retry action for the error state, since pull-to-refresh isn't
 * discoverable from an error screen with nothing to scroll).
 */
export function Screen({ children, scroll = true, onRefresh, refreshing, style, ...rest }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.content, style]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.brand[600]} /> : undefined
          }
          {...rest}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, styles.flexOne, style]} {...rest}>
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.sand[50] },
  content: { padding: spacing.lg, gap: spacing.lg },
  flexOne: { flex: 1 },
});
