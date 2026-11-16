'use client';

import { contactKindFromHref } from '@storageos/shared';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { captureClickIds, recordVisit, trackWebEvent } from '@/lib/attribution';
import { TENANT_CONSENT_EVENT } from '@/lib/tenant-consent';

/**
 * Anota de dónde viene el visitante al entrar en la web del tenant, cada
 * página que ve y los clics de contacto (llamar, WhatsApp, email, cómo llegar),
 * sin tocar las plantillas: se miran los enlaces pulsados.
 */
export function AttributionRecorder({ slug }: { slug: string }) {
  const pathname = usePathname();

  useEffect(() => {
    recordVisit(slug);
    captureClickIds(slug);
    trackWebEvent(slug, 'page_view');
  }, [slug, pathname]);

  // Si acepta las cookies estando aún en la página del anuncio, se guarda el clic.
  useEffect(() => {
    const onConsent = () => captureClickIds(slug);
    window.addEventListener(TENANT_CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(TENANT_CONSENT_EVENT, onConsent);
  }, [slug]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]');
      const href = link?.getAttribute('href');
      if (!href) return;
      const kind = contactKindFromHref(href);
      if (kind) trackWebEvent(slug, kind);
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, [slug]);

  return null;
}
