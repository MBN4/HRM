'use client';

import { Building2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchLegalEntityLogoUrl } from '../../lib/api/legal-entities';

/** The entity's logo (auth-gated, so fetched as a blob) or a neutral building glyph. */
export function EntityLogo({
  id,
  hasLogo,
  version,
}: {
  id: string;
  hasLogo: boolean;
  version: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hasLogo) {
      setUrl(null);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    fetchLegalEntityLogoUrl(id)
      .then((u) => {
        if (cancelled) URL.revokeObjectURL(u);
        else {
          revoked = u;
          setUrl(u);
        }
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id, hasLogo, version]);

  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- an auth-gated blob URL; next/image cannot optimise it
        <img src={url} alt="" className="h-full w-full object-contain" />
      ) : (
        <Building2 className="h-6 w-6" aria-hidden />
      )}
    </div>
  );
}
