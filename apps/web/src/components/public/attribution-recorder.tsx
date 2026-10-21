'use client';

import { contactKindFromHref } from '@storageos/shared';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { recordVisit, trackWebEvent } from '@/lib/attribution';

/**
 * Anota de dónde viene el visitante al entrar en la web del tenant, cada
 * página que ve y los clics de contacto (llamar, WhatsApp, email, cómo llegar),
 * sin tocar las plantillas: se miran los enlaces pulsados.
 */
export function AttributionRecorder({ slug }: { slug: string }) {
  const pathname = usePathname();

  useEffect(() => {
    recordVisit(slug);
    trackWebEvent(slug, 'page_view');
  }, [slug, pathname]);

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
