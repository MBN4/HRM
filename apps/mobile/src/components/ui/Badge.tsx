import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'brand';

const toneStyles: Record<BadgeTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.ink[100], fg: colors.ink[600] },
  success: { bg: colors.brand[50], fg: colors.brand[700] },
  warning: { bg: colors.amber[50], fg: colors.amber[600] },
  error: { bg: colors.coral[50], fg: colors.coral[600] },
  brand: { bg: colors.brand[100], fg: colors.brand[800] },
};

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  const t = toneStyles[tone];
  return (
    <View style={[styles.container, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm + 2,
  },
  text: { ...typography.label, fontSize: 11 },
});
