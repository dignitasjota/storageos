'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { useConfirm } from '@/components/confirm-provider';

/**
 * ¿El clic es en un enlace interno que cambia de página? (sin otra pestaña, sin
 * teclas, sin descarga y sin quedarse en la misma página con un ancla).
 */
export function internalNavigationTarget(
  event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>,
  location: { origin: string; pathname: string; search: string },
): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }
  const target = event.target as Element | null;
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return null;
  if (anchor.target && anchor.target !== '_self') return null;
  if (anchor.hasAttribute('download')) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  // Solo cambia el ancla: no se sale de la página.
  if (url.pathname === location.pathname && url.search === location.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Avisa antes de salir de una página con cambios sin guardar: al cerrar o
 * recargar la pestaña (`beforeunload`) y al pulsar un enlace del panel (menú
 * lateral, menú de Configuración…), con el diálogo de confirmación propio.
 *
 * El clic se intercepta en fase de captura en `document`, antes de que lo vea
 * el `<Link>` de Next: si se confirma, se navega con el router.
 */
/**
 * Lo que hay que preguntar antes de navegar desde código (no desde un enlace),
 * p. ej. el desplegable de Configuración en el móvil. Solo hay una página con
 * cambios a la vez.
 */
let pendingLeaveCheck: (() => Promise<boolean>) | null = null;

/** `true` si se puede navegar (no hay cambios, o la persona confirma que se pierden). */
export function confirmLeaveIfDirty(): Promise<boolean> {
  return pendingLeaveCheck ? pendingLeaveCheck() : Promise.resolve(true);
}

export function useUnsavedChangesGuard(dirty: boolean): void {
  const confirm = useConfirm();
  const router = useRouter();
  const asking = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const check = async (): Promise<boolean> =>
      !!(await confirm({
        title: '¿Salir sin guardar?',
        description: 'Tienes cambios sin guardar en esta página. Si sales ahora, se perderán.',
        confirmLabel: 'Salir sin guardar',
        destructive: true,
      }));
    pendingLeaveCheck = check;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Algunos navegadores aún piden un valor para enseñar el aviso.
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const href = internalNavigationTarget(e, window.location);
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      if (asking.current) return;
      asking.current = true;
      void check().then((ok) => {
        asking.current = false;
        if (ok) router.push(href);
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      if (pendingLeaveCheck === check) pendingLeaveCheck = null;
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, confirm, router]);
}

/** Resultado de guardar una parte de la página. */
export interface SaveStep {
  /** Qué se guarda («Textos legales», «SEO de la web»…), para el aviso de error. */
  label: string;
  run: () => Promise<unknown>;
}

/**
 * Guarda por orden las partes cambiadas de una página. Si una falla, sigue con
 * las demás y devuelve las que fallaron con su mensaje (lo escrito no se toca).
 */
export async function runSaveSteps(
  steps: SaveStep[],
  messageOf: (err: unknown) => string,
): Promise<{ label: string; message: string }[]> {
  const failed: { label: string; message: string }[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failed.push({ label: step.label, message: messageOf(err) });
    }
  }
  return failed;
}
