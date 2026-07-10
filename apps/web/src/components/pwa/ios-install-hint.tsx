'use client';

import { Share, X } from 'lucide-react';
import { useEffect, useState } from 'react';

const DISMISS_KEY = 'storageos.ios-install-hint.dismissed';

/**
 * Aviso de instalación para iOS. Safari en iPhone/iPad NO dispara
 * `beforeinstallprompt` (por eso `InstallPwaButton` nunca aparece ahí), así
 * que a los usuarios de iPhone —la mayoría de inquilinos— hay que explicarles
 * el gesto manual: «Compartir → Añadir a pantalla de inicio». Se muestra solo
 * en iOS, fuera del modo standalone, y es descartable (se recuerda).
 */
export function IosInstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ua = window.navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua);
    // iOS: standalone se detecta con navigator.standalone (no estándar) o el
    // display-mode. Si ya está instalada, no molestar.
    const standalone =
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    const dismissed = window.localStorage.getItem(DISMISS_KEY) === '1';
    if (isIos && !standalone && !dismissed) setShow(true);
  }, []);

  if (!show) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* almacenamiento no disponible: solo ocultamos esta vez */
    }
    setShow(false);
  }

  return (
    <div className="relative rounded-lg border border-border bg-muted/50 p-3 pr-9 text-sm">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Descartar"
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted"
      >
        <X className="size-4" />
      </button>
      <p className="font-medium">Instala «Mi trastero» en tu iPhone</p>
      <p className="mt-1 text-muted-foreground">
        Toca <Share className="inline size-4 -translate-y-0.5" aria-label="Compartir" /> «Compartir»
        y luego <span className="font-medium text-foreground">«Añadir a pantalla de inicio»</span>{' '}
        para abrirlo como una app.
      </p>
    </div>
  );
}
