import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../i18n/I18nContext';
import { useAuth } from '../lib/auth/AuthContext';
import { useBranding } from '../theme/BrandingContext';
import { getStoredTenantSlug } from '../lib/tenant';
import { ApiError } from '../lib/api/client';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Alert } from '../components/ui/Alert';
import { colors, spacing, typography } from '../theme/tokens';

/**
 * Mobile ALWAYS uses the header tenant-resolution strategy (see
 * src/lib/tenant.ts) — there is no per-tenant hostname for a native app,
 * so unlike apps/portal's login form (which only shows the "Workspace"
 * field when NOT already resolved via subdomain), this one always shows
 * it. The entered slug is persisted (see useAuth().login) so it isn't
 * retyped every launch.
 */
export function LoginScreen() {
  const { t } = useI18n();
  const { login } = useAuth();
  const { branding } = useBranding();
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStoredTenantSlug().then((slug) => {
      if (slug) setWorkspace(slug);
    });
  }, []);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password, workspace.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = workspace.trim().length > 0 && email.trim().length > 0 && password.length > 0;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.appName}>{branding.productName}</Text>
          <Text style={styles.title}>{branding.loginHeadline || t('auth.login.title')}</Text>
          <Text style={styles.subtitle}>{branding.loginSubtext || t('auth.login.subtitle')}</Text>
        </View>

        <View style={styles.form}>
          <TextField
            label={t('auth.login.workspace')}
            value={workspace}
            onChangeText={setWorkspace}
            placeholder="acme"
          />
          <Text style={styles.hint}>{t('auth.login.workspaceHint')}</Text>

          <TextField
            label={t('auth.login.email')}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="you@company.com"
          />

          <TextField
            label={t('auth.login.password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
          />

          {error && <Alert tone="error">{error}</Alert>}

          <Button
            title={submitting ? t('auth.login.submitting') : t('auth.login.submit')}
            onPress={handleSubmit}
            loading={submitting}
            disabled={!canSubmit}
            fullWidth
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.sand[50] },
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.xl },
  header: { gap: spacing.xs, marginBottom: spacing.md },
  appName: { ...typography.label, color: colors.brand[600], letterSpacing: 1 },
  title: { ...typography.title, color: colors.ink[900] },
  subtitle: { ...typography.body, color: colors.ink[500] },
  form: { gap: spacing.md },
  hint: { ...typography.small, color: colors.ink[400], marginTop: -spacing.sm },
});
