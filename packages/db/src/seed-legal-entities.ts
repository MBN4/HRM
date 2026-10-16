import type { Prisma, PrismaClient } from '@prisma/client';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Demo data for step 12.1 (multi-legal-entity): gives `acme-demo` TWO legal entities — a US entity for
 * the US HQ branch and a Qatar entity for the Doha branch — so payslips and statutory reports visibly carry
 * different legal identities per entity. Idempotent. The tenant's migration/provisioning-created DEFAULT
 * entity is repurposed as the US entity (a tenant always keeps exactly one default).
 * The registration/tax numbers are obviously fictional demo values.
 */
export async function seedDemoLegalEntities(
  client: Client,
  tenantId: string,
  branches: { usBranchId: string; qaBranchId: string },
): Promise<{ usEntityId: string; qaEntityId: string }> {
  const usData = {
    legalName: 'Acme Demo Corp, Inc.',
    countryCode: 'US',
    registrationNumber: 'DE-5551234',
    taxId: '12-3456789',
    addressLine1: '100 Market Street, Suite 400',
    city: 'New York',
    region: 'NY',
    postalCode: '10005',
  };
  const qaData = {
    legalName: 'Acme Demo Qatar W.L.L.',
    countryCode: 'QA',
    registrationNumber: 'CR-98765',
    taxId: 'TC-445566',
    addressLine1: 'Tower B, West Bay',
    addressLine2: 'P.O. Box 12345',
    city: 'Doha',
    postalCode: '00000',
  };

  const existingDefault = await client.legalEntity.findFirst({
    where: { tenantId, isDefault: true },
  });
  const us = existingDefault
    ? await client.legalEntity.update({ where: { id: existingDefault.id }, data: usData })
    : await client.legalEntity.create({ data: { tenantId, isDefault: true, ...usData } });

  const existingQa = await client.legalEntity.findFirst({
    where: { tenantId, legalName: qaData.legalName },
  });
  const qa = existingQa
    ? await client.legalEntity.update({ where: { id: existingQa.id }, data: qaData })
    : await client.legalEntity.create({ data: { tenantId, isDefault: false, ...qaData } });

  await client.branch.update({
    where: { id: branches.usBranchId },
    data: { legalEntityId: us.id },
  });
  await client.branch.update({
    where: { id: branches.qaBranchId },
    data: { legalEntityId: qa.id },
  });
  return { usEntityId: us.id, qaEntityId: qa.id };
}
