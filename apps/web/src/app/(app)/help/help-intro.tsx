'use client';

import Link from 'next/link';

import { useRouteAccess } from '@/lib/navigation/route-access';

const GETTING_STARTED_HREF = '/settings/getting-started';

/** Entradilla de «Cómo funciona»: la puesta en marcha solo si puede abrirla. */
export function HelpIntro() {
  const access = useRouteAccess();
  return (
    <p className="text-sm text-muted-foreground">
      El día a día con TrasterOS: qué pasa solo y qué haces tú.{' '}
      {access(GETTING_STARTED_HREF).allowed && (
        <>
          Para empezar, revisa la{' '}
          <Link href={GETTING_STARTED_HREF} className="text-primary hover:underline">
            puesta en marcha
          </Link>
          .{' '}
        </>
      )}
      Si algo no queda claro,{' '}
      <Link href="/support" className="text-primary hover:underline">
        escríbenos
      </Link>
      .
    </p>
  );
}
