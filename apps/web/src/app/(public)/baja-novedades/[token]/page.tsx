'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { ProductUpdatesDigestUnsubscribeDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

/**
 * Baja del resumen mensual de novedades de TrasterOS desde el enlace del
 * correo. Pide confirmación con un botón: algunos filtros de correo abren los
 * enlaces solos y no deben dar de baja a nadie.
 */
export default function UnsubscribeDigestPage() {
  const { token } = useParams<{ token: string }>();
  const path = `/public/product-updates-digest/unsubscribe/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<ProductUpdatesDigestUnsubscribeDto | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<ProductUpdatesDigestUnsubscribeDto>(path, { requiresAuth: false })
      .then(setInfo)
      .catch(() => setError(true));
  }, [path]);

  async function confirm() {
    setBusy(true);
    try {
      setInfo(
        await apiFetch<ProductUpdatesDigestUnsubscribeDto>(path, {
          method: 'POST',
          requiresAuth: false,
        }),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/30 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-lg">Resumen mensual de novedades</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error ? (
            <p className="text-destructive">Este enlace de baja no es válido.</p>
          ) : !info ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : info.unsubscribed ? (
            <>
              <p className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                Listo: {info.email} ya no recibirá el resumen mensual de novedades de TrasterOS.
              </p>
              <p className="text-muted-foreground">
                Puedes volver a activarlo cuando quieras en tu perfil, en la pestaña «Avisos». Las
                novedades siguen en el panel, en «Novedades».
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link href="/settings/profile?tab=notices">Ir a mis avisos</Link>
              </Button>
            </>
          ) : (
            <>
              <p>
                ¿Quieres dejar de recibir en {info.email} el resumen mensual de lo que añadimos y
                mejoramos en TrasterOS?
              </p>
              <Button onClick={() => void confirm()} disabled={busy} className="w-full">
                {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
                Darme de baja
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
