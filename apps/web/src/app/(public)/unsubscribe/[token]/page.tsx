'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { UnsubscribeInfoDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

/**
 * Baja de las comunicaciones comerciales desde el enlace del correo. Pide
 * confirmación con un botón: algunos filtros de correo abren los enlaces
 * automáticamente y no deben dar de baja a nadie.
 */
export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<UnsubscribeInfoDto | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<UnsubscribeInfoDto>(`/public/unsubscribe/${encodeURIComponent(token)}`, {
      requiresAuth: false,
    })
      .then(setInfo)
      .catch(() => setError(true));
  }, [token]);

  async function confirm() {
    setBusy(true);
    try {
      setInfo(
        await apiFetch<UnsubscribeInfoDto>(`/public/unsubscribe/${encodeURIComponent(token)}`, {
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
          <CardTitle className="text-lg">
            {info ? `Comunicaciones de ${info.tenantName}` : 'Darse de baja'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error ? (
            <p className="text-destructive">Este enlace de baja no es válido.</p>
          ) : !info ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : info.unsubscribed ? (
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              Listo: {info.email} ya no recibirá campañas ni ofertas de {info.tenantName}. Seguirás
              recibiendo los correos necesarios de tu contrato (facturas, avisos de pago, accesos).
            </p>
          ) : (
            <>
              <p>
                ¿Quieres dejar de recibir campañas y ofertas de {info.tenantName} en {info.email}?
                Seguirás recibiendo los correos necesarios de tu contrato.
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
