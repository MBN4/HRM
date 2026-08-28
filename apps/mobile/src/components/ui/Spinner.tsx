import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors, spacing } from '../../theme/tokens';

export function PageSpinner() {
  return (
    <View style={styles.container}>
      <ActivityIndicator color={colors.brand[600]} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: spacing.xxl, alignItems: 'center', justifyContent: 'center' },
});
