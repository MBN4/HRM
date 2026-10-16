import { PERMISSIONS } from '@hrm/shared';
import { RequiresPermission } from '../common/permissions/requires-permission.decorator';

export interface LegalEntityBankDetailsView {
  bankName: string | null;
  accountNumberMasked: string;
  routingCodeMasked: string | null;
}

/**
 * `bankDetails` is field-level gated behind `salary.view` (OMITTED, not nulled, for a caller without
 * it — the standard `@RequiresPermission` mechanism) AND is only ever the MASKED form even for holders;
 * the encrypted columns themselves never leave the service. `hasBankDetails` stays visible so an editor
 * can tell whether something is on file. See docs/conventions/legal-entities.md.
 */
export class LegalEntityResponseDto {
  id!: string;
  legalName!: string;
  countryCode!: string;
  registrationNumber!: string | null;
  taxId!: string | null;
  /** Country-Pack-driven display labels for the two generic identifiers above. */
  registrationNumberLabel!: string;
  taxIdLabel!: string;
  addressLine1!: string | null;
  addressLine2!: string | null;
  city!: string | null;
  region!: string | null;
  postalCode!: string | null;
  addressLines!: string[];
  hasLogo!: boolean;
  isDefault!: boolean;
  hasBankDetails!: boolean;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  bankDetails!: {
    bankName: string | null;
    accountNumberMasked: string;
    routingCodeMasked: string | null;
  } | null;

  branchCount!: number;
  branches?: { id: string; name: string; countryCode: string }[];
  createdAt!: string;
  updatedAt!: string;

  constructor(partial: LegalEntityResponseDto) {
    Object.assign(this, partial);
  }
}
