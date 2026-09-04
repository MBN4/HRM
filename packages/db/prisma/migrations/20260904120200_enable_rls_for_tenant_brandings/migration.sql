-- `tenant_brandings` (step 4.3, white-label) IS tenant-scoped — ordinary
-- RLS applies, identical `tenant_isolation` policy pattern to every other
-- tenant-owned table in this schema (see docs/conventions/tenancy-rls.md).
--
-- `tenant_domains`'s new columns (added in the prior migration) need NO
-- grant change here: that table stays deliberately RLS-EXEMPT (see the
-- comment on the TenantDomain model in schema.prisma) and hrm_app keeps
-- its existing SELECT-only grant — the new write path
-- (BrandingDomainService) goes through the OWNER `prisma` client, not
-- `hrm_app`/`tx`, for the same reason `Tenant.status` writes do (RLS
-- cannot help on an RLS-exempt table; the application itself must scope
-- by tenantId). See docs/conventions/white-label.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_brandings" TO hrm_app;

ALTER TABLE "tenant_brandings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_brandings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tenant_brandings"
  USING ("tenant_id" = current_setting('app.current_tenant')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant')::uuid);
