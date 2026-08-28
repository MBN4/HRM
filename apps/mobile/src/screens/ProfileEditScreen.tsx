import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Plus, Trash2 } from 'lucide-react-native';
import { useI18n } from '../i18n/I18nContext';
import { useSession } from '../lib/session/SessionContext';
import { updateEmployee, UpdateEmployeeInput } from '../lib/api/employees';
import { ApiError } from '../lib/api/client';
import { Screen } from '../components/ui/Screen';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Alert } from '../components/ui/Alert';
import { PageSpinner } from '../components/ui/Spinner';
import { colors, spacing, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';

interface ContactRow {
  id: string;
  name: string;
  relationship: string;
  phone: string;
}

interface DependentRow {
  id: string;
  name: string;
  relationship: string;
  dateOfBirth: string;
}

export function ProfileEditScreen() {
  const { employee, employeeLoading, refreshEmployee } = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  if (employeeLoading || !employee) return <PageSpinner />;

  return <ProfileEditFormBody employeeId={employee.id} initial={employee} onSaved={async () => { await refreshEmployee(); navigation.goBack(); }} />;
}

function ProfileEditFormBody({
  employeeId,
  initial,
  onSaved,
}: {
  employeeId: string;
  initial: {
    personalEmail: string | null;
    phone: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    emergencyContacts: ContactRow[];
    dependents: { id: string; name: string; relationship: string; dateOfBirth: string | null }[];
  };
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [personalEmail, setPersonalEmail] = useState(initial.personalEmail ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(initial.dateOfBirth ? initial.dateOfBirth.slice(0, 10) : '');
  const [gender, setGender] = useState(initial.gender ?? '');
  const [contacts, setContacts] = useState<ContactRow[]>(initial.emergencyContacts.map((c) => ({ ...c })));
  const [dependents, setDependents] = useState<DependentRow[]>(
    initial.dependents.map((d) => ({ ...d, dateOfBirth: d.dateOfBirth ?? '' })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const input: UpdateEmployeeInput = {
        personalEmail: personalEmail || undefined,
        phone: phone || undefined,
        dateOfBirth: dateOfBirth || undefined,
        gender: gender || undefined,
        emergencyContacts: contacts.map(({ name, relationship, phone: p }) => ({ name, relationship, phone: p })),
        dependents: dependents.map(({ name, relationship, dateOfBirth: dob }) => ({ name, relationship, dateOfBirth: dob || undefined })),
      };
      await updateEmployee(employeeId, input);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>{t('profile.editTitle')}</Text>

      <TextField label={t('profile.personalEmail')} value={personalEmail} onChangeText={setPersonalEmail} keyboardType="email-address" />
      <TextField label={t('profile.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <TextField label={t('profile.dateOfBirth')} value={dateOfBirth} onChangeText={setDateOfBirth} placeholder="YYYY-MM-DD" />
      <TextField label={t('profile.gender')} value={gender} onChangeText={setGender} />

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('profile.emergencyContacts')}</Text>
          <Button
            title={t('profile.addEmergencyContact')}
            variant="ghost"
            icon={<Plus size={14} color={colors.brand[700]} />}
            onPress={() => setContacts((c) => [...c, { id: `new-${c.length}-${Date.now()}`, name: '', relationship: '', phone: '' }])}
          />
        </View>
        {contacts.map((c, i) => (
          <View key={c.id} style={styles.listItem}>
            <TextField label={t('common.name')} value={c.name} onChangeText={(v) => setContacts((rows) => rows.map((r, idx) => (idx === i ? { ...r, name: v } : r)))} />
            <TextField
              label={t('common.relationship')}
              value={c.relationship}
              onChangeText={(v) => setContacts((rows) => rows.map((r, idx) => (idx === i ? { ...r, relationship: v } : r)))}
            />
            <TextField
              label={t('common.phone')}
              value={c.phone}
              keyboardType="phone-pad"
              onChangeText={(v) => setContacts((rows) => rows.map((r, idx) => (idx === i ? { ...r, phone: v } : r)))}
            />
            <Button title={t('common.remove')} variant="ghost" icon={<Trash2 size={14} color={colors.coral[600]} />} onPress={() => setContacts((rows) => rows.filter((_, idx) => idx !== i))} />
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('profile.dependents')}</Text>
          <Button
            title={t('profile.addDependent')}
            variant="ghost"
            icon={<Plus size={14} color={colors.brand[700]} />}
            onPress={() => setDependents((d) => [...d, { id: `new-${d.length}-${Date.now()}`, name: '', relationship: '', dateOfBirth: '' }])}
          />
        </View>
        {dependents.map((d, i) => (
          <View key={d.id} style={styles.listItem}>
            <TextField label={t('common.name')} value={d.name} onChangeText={(v) => setDependents((rows) => rows.map((r, idx) => (idx === i ? { ...r, name: v } : r)))} />
            <TextField
              label={t('common.relationship')}
              value={d.relationship}
              onChangeText={(v) => setDependents((rows) => rows.map((r, idx) => (idx === i ? { ...r, relationship: v } : r)))}
            />
            <TextField
              label={t('profile.dateOfBirth')}
              value={d.dateOfBirth}
              placeholder="YYYY-MM-DD"
              onChangeText={(v) => setDependents((rows) => rows.map((r, idx) => (idx === i ? { ...r, dateOfBirth: v } : r)))}
            />
            <Button title={t('common.remove')} variant="ghost" icon={<Trash2 size={14} color={colors.coral[600]} />} onPress={() => setDependents((rows) => rows.filter((_, idx) => idx !== i))} />
          </View>
        ))}
      </View>

      {error && <Alert tone="error">{error}</Alert>}

      <Button title={t('action.save')} onPress={handleSave} loading={saving} fullWidth />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.ink[900] },
  section: { gap: spacing.sm },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { ...typography.heading, color: colors.ink[900] },
  listItem: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.white, borderRadius: 12, borderWidth: 1, borderColor: colors.ink[100] },
});
