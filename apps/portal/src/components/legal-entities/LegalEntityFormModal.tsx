'use client';

import { FormEvent, useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { ApiError } from '../../lib/api/client';
import {
  createLegalEntity,
  updateLegalEntity,
  uploadLegalEntityLogo,
  type LegalEntity,
  type LegalEntityInput,
} from '../../lib/api/legal-entities';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Modal } from '../ui/Modal';

/**
 * Create / edit a legal entity (step 12.1). The registration/tax labels come from the entity's Country Pack
 * (returned by the API on edit; the generic wording while creating). Bank details are write-mostly: the
 * stored values are never echoed back, only a masked "on file" hint — and for a caller without `salary.view`
 * not even that.
 */
export function LegalEntityFormModal({
  entity,
  onClose,
  onSaved,
}: {
  entity: LegalEntity | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [legalName, setLegalName] = useState(entity?.legalName ?? '');
  const [countryCode, setCountryCode] = useState(entity?.countryCode ?? '');
  const [registrationNumber, setRegistrationNumber] = useState(entity?.registrationNumber ?? '');
  const [taxId, setTaxId] = useState(entity?.taxId ?? '');
  const [addressLine1, setAddressLine1] = useState(entity?.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(entity?.addressLine2 ?? '');
  const [city, setCity] = useState(entity?.city ?? '');
  const [region, setRegion] = useState(entity?.region ?? '');
  const [postalCode, setPostalCode] = useState(entity?.postalCode ?? '');
  const [bankName, setBankName] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [bankRouting, setBankRouting] = useState('');
  const [removeBank, setRemoveBank] = useState(false);
  const [logo, setLogo] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = entity?.hasBankDetails ?? false;
  const canSeeBank = can(PERMISSIONS.SALARY_VIEW);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input: LegalEntityInput = {
        legalName: legalName.trim(),
        countryCode: countryCode.trim().toUpperCase(),
        registrationNumber: registrationNumber.trim(),
        taxId: taxId.trim(),
        addressLine1: addressLine1.trim(),
        addressLine2: addressLine2.trim(),
        city: city.trim(),
        region: region.trim(),
        postalCode: postalCode.trim(),
      };
      if (removeBank) {
        input.bankDetails = null;
      } else if (bankAccount.trim() || bankName.trim()) {
        input.bankDetails = {
          bankName: bankName.trim(),
          accountNumber: bankAccount.trim(),
          routingCode: bankRouting.trim() || null,
        };
      }
      const saved = entity
        ? await updateLegalEntity(entity.id, input)
        : await createLegalEntity(input);
      if (logo) {
        await uploadLegalEntityLogo(saved.id, logo);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={entity ? t('entity.form.editTitle') : t('entity.form.createTitle')}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4" data-testid="entity-form">
        {error && <Alert tone="error">{error}</Alert>}
        <div>
          <Label htmlFor="entity-legal-name">{t('entity.field.legalName')}</Label>
          <Input
            id="entity-legal-name"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            required
            maxLength={200}
            data-testid="entity-legal-name"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="entity-country">{t('entity.field.country')}</Label>
            <Input
              id="entity-country"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              required
              minLength={2}
              maxLength={2}
              dir="ltr"
              className="uppercase"
              data-testid="entity-country"
            />
            <p className="mt-1 text-xs text-ink-400">{t('entity.field.countryHint')}</p>
          </div>
          <div />
          <div>
            <Label htmlFor="entity-reg">
              {entity?.registrationNumberLabel ?? t('entity.field.registrationNumber')}
            </Label>
            <Input
              id="entity-reg"
              value={registrationNumber}
              onChange={(e) => setRegistrationNumber(e.target.value)}
              maxLength={80}
              dir="ltr"
              data-testid="entity-registration"
            />
          </div>
          <div>
            <Label htmlFor="entity-tax">{entity?.taxIdLabel ?? t('entity.field.taxId')}</Label>
            <Input
              id="entity-tax"
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              maxLength={80}
              dir="ltr"
              data-testid="entity-tax"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="entity-addr1">{t('entity.field.address1')}</Label>
            <Input
              id="entity-addr1"
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              maxLength={200}
              data-testid="entity-address1"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="entity-addr2">{t('entity.field.address2')}</Label>
            <Input
              id="entity-addr2"
              value={addressLine2}
              onChange={(e) => setAddressLine2(e.target.value)}
              maxLength={200}
            />
          </div>
          <div>
            <Label htmlFor="entity-city">{t('entity.field.city')}</Label>
            <Input
              id="entity-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              maxLength={100}
              data-testid="entity-city"
            />
          </div>
          <div>
            <Label htmlFor="entity-region">{t('entity.field.region')}</Label>
            <Input
              id="entity-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              maxLength={100}
            />
          </div>
          <div>
            <Label htmlFor="entity-postal">{t('entity.field.postalCode')}</Label>
            <Input
              id="entity-postal"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              maxLength={32}
              dir="ltr"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="entity-logo">{t('entity.field.logo')}</Label>
          <input
            id="entity-logo"
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-ink-600 file:me-3 file:rounded-lg file:border-0 file:bg-sand-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink-700"
            data-testid="entity-logo-input"
          />
          <p className="mt-1 text-xs text-ink-400">{t('entity.field.logoHint')}</p>
        </div>

        <fieldset className="space-y-3 rounded-xl border border-ink-100 p-4">
          <legend className="px-1 text-sm font-medium text-ink-800">
            {t('entity.bank.title')}
          </legend>
          <p className="text-xs text-ink-500">{t('entity.bank.hint')}</p>
          {onFile && canSeeBank && entity?.bankDetails && (
            <Alert tone="info">
              {t('entity.bank.onFile', {
                bank: entity.bankDetails.bankName ?? '',
                account: entity.bankDetails.accountNumberMasked,
              })}{' '}
              {t('entity.bank.keep')}
            </Alert>
          )}
          {onFile && !canSeeBank && <Alert tone="info">{t('entity.bank.restricted')}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="entity-bank-name">{t('entity.bank.name')}</Label>
              <Input
                id="entity-bank-name"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                maxLength={120}
                disabled={removeBank}
                autoComplete="off"
                data-testid="entity-bank-name"
              />
            </div>
            <div>
              <Label htmlFor="entity-bank-account">{t('entity.bank.account')}</Label>
              <Input
                id="entity-bank-account"
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value)}
                maxLength={64}
                dir="ltr"
                disabled={removeBank}
                autoComplete="off"
                data-testid="entity-bank-account"
              />
            </div>
            <div>
              <Label htmlFor="entity-bank-routing">{t('entity.bank.routing')}</Label>
              <Input
                id="entity-bank-routing"
                value={bankRouting}
                onChange={(e) => setBankRouting(e.target.value)}
                maxLength={64}
                dir="ltr"
                disabled={removeBank}
                autoComplete="off"
              />
            </div>
          </div>
          {onFile && (
            <label className="flex items-center gap-2 text-sm text-ink-600">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={removeBank}
                onChange={(e) => setRemoveBank(e.target.checked)}
              />
              {t('entity.bank.remove')}
            </label>
          )}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('entity.cancel')}
          </Button>
          <Button type="submit" disabled={submitting} data-testid="entity-save">
            {t('entity.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
