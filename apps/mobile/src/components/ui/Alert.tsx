import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';

export type AlertTone = 'error' | 'success' | 'info' | 'warning';

const toneStyles: Record<AlertTone, { bg: string; fg: string }> = {
  error: { bg: colors.coral[50], fg: colors.coral[600] },
  success: { bg: colors.brand[50], fg: colors.brand[700] },
  info: { bg: colors.sand[100], fg: colors.ink[700] },
  warning: { bg: colors.amber[50], fg: colors.amber[600] },
};

export function Alert({ tone = 'info', children }: { tone?: AlertTone; children: React.ReactNode }) {
  const t = toneStyles[tone];
  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
  },
  text: { ...typography.small, lineHeight: 18 },
});
