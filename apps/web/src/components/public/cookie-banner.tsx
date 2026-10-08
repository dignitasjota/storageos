'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  CONSENT_EVENT,
  needsConsentPrompt,
  saveConsent,
  type CookieConsent,
} from '@/components/public/cookie-consent';
import { Button } from '@/components/ui/button';

/**
 * Aviso de cookies de la web de TrasterOS. Sin analítica configurada solo hay
 * cookies necesarias («Aceptar»); con Google Analytics, el visitante elige entre
 * «Solo necesarias» y «Aceptar todas» (la analítica no se carga sin su permiso).
 */
export function CookieBanner({ analytics = false }: { analytics?: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(needsConsentPrompt(analytics));
    const onChange = (e: Event) => {
      if ((e as CustomEvent<CookieConsent | null>).detail === null) setVisible(true);
    };
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, [analytics]);

  function choose(value: CookieConsent) {
    saveConsent(value);
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-xl border border-border bg-background/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {analytics
            ? 'Usamos cookies necesarias para que la web funcione y, si lo aceptas, cookies de analítica (Google Analytics) para saber cómo se usa y mejorarla. '
            : 'Usamos cookies estrictamente necesarias para que la plataforma funcione y sea segura. Al continuar, aceptas su uso. '}
          Más información en nuestra{' '}
          <Link href="/cookies" className="font-medium text-foreground underline">
            Política de Cookies
          </Link>
          .
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {analytics ? (
            <>
              <Button variant="outline" size="sm" onClick={() => choose('necessary')}>
                Solo necesarias
              </Button>
              <Button size="sm" onClick={() => choose('all')}>
                Aceptar todas
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href="/cookies">Más información</Link>
              </Button>
              <Button size="sm" onClick={() => choose('necessary')}>
                Aceptar
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
