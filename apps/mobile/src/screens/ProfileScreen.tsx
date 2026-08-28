import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useI18n } from '../i18n/I18nContext';
import { useAuth } from '../lib/auth/AuthContext';
import { useSession } from '../lib/session/SessionContext';
import { PERMISSIONS } from '../constants/permissions';
import { Screen } from '../components/ui/Screen';
import { Card, CardBody, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { PageSpinner } from '../components/ui/Spinner';
import { formatDate } from '../lib/format';
import { colors, spacing, typography } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/types';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function ProfileScreen() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const { employee, employeeLoading } = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  if (employeeLoading) return <PageSpinner />;

  if (!employee) {
    return (
      <Screen>
        <Alert tone="info">{t('profile.noEmployeeProfile')}</Alert>
      </Screen>
    );
  }

  const canEdit = can(PERMISSIONS.EMPLOYEE_WRITE);
  const hasSalaryField = 'compensation' in employee;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.name}>
          {employee.firstName} {employee.lastName}
        </Text>
        <Text style={styles.code}>{employee.employeeCode}</Text>
      </View>

      {canEdit ? (
        <Button title={t('profile.edit')} onPress={() => navigation.navigate('ProfileEdit')} variant="secondary" />
      ) : (
        <Alert tone="info">{t('profile.readOnlyNotice')}</Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.personalInfo')}</CardTitle>
        </CardHeader>
        <CardBody style={styles.body}>
          <Row label={t('profile.personalEmail')} value={employee.personalEmail ?? '—'} />
          <Row label={t('profile.phone')} value={employee.phone ?? '—'} />
          <Row label={t('profile.dateOfBirth')} value={formatDate(employee.dateOfBirth, locale)} />
          <Row label={t('profile.gender')} value={employee.gender ?? '—'} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.employment')}</CardTitle>
        </CardHeader>
        <CardBody style={styles.body}>
          <Row label={t('profile.employmentType')} value={employee.employmentType} />
          <Row label={t('profile.joinDate')} value={formatDate(employee.joinDate, locale)} />
          <Row label={t('profile.status')} value={employee.status} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.compensation')}</CardTitle>
        </CardHeader>
        <CardBody>
          {hasSalaryField && employee.compensation ? (
            <Row label={t('profile.baseSalary')} value={`${employee.compensation.baseSalary} ${employee.compensation.salaryCurrency ?? ''}`} />
          ) : (
            <Text style={styles.muted}>{t('profile.noSalaryAccess')}</Text>
          )}
        </CardBody>
      </Card>

      {employee.emergencyContacts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.emergencyContacts')}</CardTitle>
          </CardHeader>
          <CardBody style={styles.body}>
            {employee.emergencyContacts.map((c) => (
              <Row key={c.id} label={`${c.name} (${c.relationship})`} value={c.phone} />
            ))}
          </CardBody>
        </Card>
      )}

      {employee.dependents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.dependents')}</CardTitle>
          </CardHeader>
          <CardBody style={styles.body}>
            {employee.dependents.map((d) => (
              <Row key={d.id} label={`${d.name} (${d.relationship})`} value={formatDate(d.dateOfBirth, locale)} />
            ))}
          </CardBody>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: 2 },
  name: { ...typography.title, color: colors.ink[900] },
  code: { ...typography.small, color: colors.ink[400] },
  body: { gap: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowLabel: { ...typography.small, color: colors.ink[500] },
  rowValue: { ...typography.body, color: colors.ink[900], flexShrink: 1, textAlign: 'right' },
  muted: { ...typography.small, color: colors.ink[400] },
});
