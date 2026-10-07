'use client';

import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import {
  saveMemberPolicy,
  saveTeamPolicy,
  type WorkingHoursPolicy,
  type WorkingHoursTargets,
} from '../../lib/api/working-hours';
import { Label } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { DEFAULT_FORM, PolicyForm, valuesFromPolicy } from './PolicyForm';

/**
 * Add / edit a TEAM or MEMBER override. Adding shows a searchable picker;
 * editing (`policy` given) fixes the target. Targets already holding an
 * override are left out of the add picker (the server upserts anyway).
 */
export function OverrideModal({
  kind,
  targets,
  policy,
  takenIds,
  onClose,
  onSaved,
}: {
  kind: 'TEAM' | 'MEMBER';
  targets: WorkingHoursTargets;
  policy?: WorkingHoursPolicy;
  takenIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [targetId, setTargetId] = useState(policy?.target?.id ?? '');
  const isTeam = kind === 'TEAM';

  return (
    <Modal title={t(policy ? (isTeam ? 'workingHours.team.edit' : 'workingHours.member.edit') : isTeam ? 'workingHours.team.add' : 'workingHours.member.add')} onClose={onClose}>
      <PolicyForm
        formTestId="wh-override-form"
        idPrefix="wh-override"
        testPrefix="wh-override"
        initial={policy ? valuesFromPolicy(policy) : DEFAULT_FORM}
        submitLabel={t('action.save')}
        onCancel={onClose}
        validateExtra={() => (targetId ? null : t(isTeam ? 'workingHours.err.pickTeam' : 'workingHours.err.pickMember'))}
        extra={
          policy ? (
            <p className="text-sm text-ink-700">
              <span className="font-medium">{t(isTeam ? 'workingHours.team.label' : 'workingHours.member.label')}: </span>
              {policy.target?.label}
              {policy.target?.code ? ` (${policy.target.code})` : ''}
            </p>
          ) : (
            <div>
              <Label htmlFor="wh-override-target">{t(isTeam ? 'workingHours.team.label' : 'workingHours.member.label')}</Label>
              <Select id="wh-override-target" searchable value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="wh-override-target">
                <option value="">{t(isTeam ? 'workingHours.team.pick' : 'workingHours.member.pick')}</option>
                {isTeam
                  ? targets.departments
                      .filter((d) => !takenIds.has(d.id))
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} — {d.branchName}
                        </option>
                      ))
                  : targets.employees
                      .filter((e) => !takenIds.has(e.id))
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} ({e.code})
                        </option>
                      ))}
              </Select>
            </div>
          )
        }
        onSubmit={async (input) => {
          if (isTeam) await saveTeamPolicy(targetId, input);
          else await saveMemberPolicy(targetId, input);
          onSaved();
        }}
      />
    </Modal>
  );
}
