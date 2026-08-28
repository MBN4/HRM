import React, { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useI18n } from '../i18n/I18nContext';
import { useAuth } from '../lib/auth/AuthContext';
import { apiChangePassword } from '../lib/api/auth';
import { ApiError } from '../lib/api/client';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Alert } from '../components/ui/Alert';
import { colors, spacing, typography } from '../theme/tokens';

export function SettingsScreen() {
  const { t, locale, setLocale } = useI18n();
  const { logout, logoutAll } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleChangePassword() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await apiChangePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>{t('settings.title')}</Text>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.language')}</CardTitle>
        </CardHeader>
        <CardBody style={styles.languageRow}>
          <Button title="English" variant={locale === 'en' ? 'primary' : 'secondary'} onPress={() => setLocale('en')} />
          <Button title="العربية" variant={locale === 'ar' ? 'primary' : 'secondary'} onPress={() => setLocale('ar')} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.changePassword')}</CardTitle>
        </CardHeader>
        <CardBody style={styles.form}>
          <TextField label={t('settings.currentPassword')} value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry />
          <TextField label={t('settings.newPassword')} value={newPassword} onChangeText={setNewPassword} secureTextEntry />
          {error && <Alert tone="error">{error}</Alert>}
          {success && <Alert tone="success">{t('settings.passwordChanged')}</Alert>}
          <Button title={t('action.save')} onPress={handleChangePassword} loading={saving} disabled={!currentPassword || newPassword.length < 8} />
        </CardBody>
      </Card>

      <Card>
        <CardBody style={styles.form}>
          <Button title={t('nav.signOut')} variant="secondary" onPress={() => void logout()} />
          <Button title={t('settings.signOutAll')} variant="danger" onPress={() => void logoutAll()} />
        </CardBody>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  languageRow: { flexDirection: 'row', gap: spacing.sm },
  form: { gap: spacing.md },
});
