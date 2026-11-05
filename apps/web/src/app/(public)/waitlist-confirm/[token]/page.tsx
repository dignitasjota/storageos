'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { WaitlistInterestViewDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

/**
 * Respuesta al correo «¿Sigues buscando?» de la lista de espera. Pide pulsar un
 * botón: algunos filtros de correo abren los enlaces por su cuenta.
 */
export default function WaitlistConfirmPage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<WaitlistInterestViewDto | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch<WaitlistInterestViewDto>(`/public/waitlist/interest/${encodeURIComponent(token)}`, {
      requiresAuth: false,
    })
      .then(setInfo)
      .catch(() => setError(true));
  }, [token]);

  async function respond(stillInterested: boolean) {
    setBusy(true);
    try {
      await apiFetch<void>(`/public/waitlist/interest/${encodeURIComponent(token)}`, {
        method: 'POST',
        json: { stillInterested },
        requiresAuth: false,
      });
      setAnswer(stillInterested);
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
          <CardTitle className="text-lg">{info ? info.tenantName : 'Lista de espera'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error ? (
            <p className="text-destructive">Este enlace ya no es válido.</p>
          ) : !info ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : answer !== null ? (
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              {answer
                ? 'Gracias: sigues en la lista y te avisaremos en cuanto haya uno libre.'
                : 'Hecho: ya no estás en la lista de espera.'}
            </p>
          ) : info.closed ? (
            <p>Ya no estás en esta lista de espera.</p>
          ) : (
            <>
              <p>
                {info.contactName}, ¿sigues buscando un {info.unitTypeName} en {info.facilityName}?
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button className="flex-1" disabled={busy} onClick={() => void respond(true)}>
                  Sí, seguir en la lista
                </Button>
                <Button
                  className="flex-1"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void respond(false)}
                >
                  Ya no lo necesito
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
