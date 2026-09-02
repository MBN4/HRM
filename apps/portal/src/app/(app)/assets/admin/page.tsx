'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { listAssetCategories, listAssets } from '../../../../lib/api/assets';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { AssetCategoryForm } from '../../../../components/assets/AssetCategoryForm';
import { RegisterAssetForm } from '../../../../components/assets/RegisterAssetForm';
import { AssetRow } from '../../../../components/assets/AssetRow';

export default function AssetsAdminPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [addingCategory, setAddingCategory] = useState(false);
  const [registering, setRegistering] = useState(false);

  const canManage = can(PERMISSIONS.ASSET_MANAGE);
  const { data: categories, reload: reloadCategories } = useAsync(() => (canManage ? listAssetCategories() : Promise.resolve([])), [canManage]);
  const { data: assets, loading, reload: reloadAssets } = useAsync(() => (canManage ? listAssets() : Promise.resolve([])), [canManage]);

  if (!canManage) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('assets.admin.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('assets.admin.categories')}</CardTitle>
          <Button size="sm" onClick={() => setAddingCategory(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('assets.admin.newCategory')}
          </Button>
        </CardHeader>
        <CardBody>
          {!categories || categories.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {categories.map((c) => (
                <li key={c.id} className="py-2 text-ink-800">
                  {c.name} <span className="text-ink-400">({c.code})</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('assets.admin.register')}</CardTitle>
          <Button size="sm" data-testid="register-asset-button" onClick={() => setRegistering(true)} disabled={!categories || categories.length === 0}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('assets.admin.register')}
          </Button>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !assets || assets.length === 0 ? (
            <EmptyState title={t('assets.noAssets')} />
          ) : (
            <div className="divide-y divide-ink-100">
              {assets.map((asset) => (
                <AssetRow key={asset.id} asset={asset} categories={categories ?? []} locale={locale} onChanged={reloadAssets} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {addingCategory && (
        <Modal title={t('assets.admin.newCategory')} onClose={() => setAddingCategory(false)}>
          <AssetCategoryForm
            onCancel={() => setAddingCategory(false)}
            onSaved={() => {
              setAddingCategory(false);
              reloadCategories();
            }}
          />
        </Modal>
      )}

      {registering && (
        <Modal title={t('assets.admin.register')} onClose={() => setRegistering(false)}>
          <RegisterAssetForm
            categories={categories ?? []}
            onCancel={() => setRegistering(false)}
            onSaved={() => {
              setRegistering(false);
              reloadAssets();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
