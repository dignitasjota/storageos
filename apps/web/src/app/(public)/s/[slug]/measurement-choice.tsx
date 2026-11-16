'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { measurementAllowed, TENANT_CONSENT_EVENT, writeTenantConsent } from '@/lib/tenant-consent';

/**
 * En la política de cookies: el visitante ve si se miden sus visitas y puede
 * dejar de medirlas («Solo necesarias») o volver a medirlas.
 */
export function MeasurementChoice({ slug }: { slug: string }) {
  const t = useTranslations('publicWeb.legal');
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    setAllowed(measurementAllowed(slug));
    const onChange = () => setAllowed(measurementAllowed(slug));
    window.addEventListener(TENANT_CONSENT_EVENT, onChange);
    return () => window.removeEventListener(TENANT_CONSENT_EVENT, onChange);
  }, [slug]);

  if (allowed === null) return null;
  return (
    <section aria-labelledby="measurement-choice" className="mt-10 rounded-xl border p-4">
      <h2 id="measurement-choice" className="text-base font-semibold">
        {t('measurementTitle')}
      </h2>
      <p role="status" className="mt-1 text-sm text-muted-foreground">
        {allowed ? t('measurementOn') : t('measurementOff')}
      </p>
      <button
        type="button"
        onClick={() => writeTenantConsent(slug, allowed ? 'necessary' : null)}
        className="mt-3 h-9 rounded-md border px-3 text-sm font-medium hover:bg-accent"
      >
        {allowed ? t('measurementStop') : t('measurementResume')}
      </button>
    </section>
  );
}
