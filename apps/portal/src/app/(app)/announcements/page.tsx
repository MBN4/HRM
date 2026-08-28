'use client';

import { Megaphone } from 'lucide-react';
import { useI18n } from '../../../i18n/I18nProvider';
import { Card, CardBody } from '../../../components/ui/Card';

/**
 * A deliberate SEAM, not a feature — the real announcements module is
 * Phase 3 (see /CLAUDE.md § 6, "Not yet built"). This route/nav entry
 * exists now so its place in the product is established, without building
 * any backend behind it — see docs/conventions/frontend-ess-mss.md.
 */
export default function AnnouncementsPage() {
  const { t } = useI18n();
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('announcements.title')}</h1>
      <Card>
        <CardBody className="flex flex-col items-center gap-3 py-16 text-center">
          <Megaphone className="h-8 w-8 text-ink-300" aria-hidden />
          <p className="max-w-sm text-sm text-ink-500">{t('announcements.comingSoon')}</p>
        </CardBody>
      </Card>
    </div>
  );
}
