'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { completeGoCardlessMandatePortal } from '@/lib/payments/gocardless';

type State = 'loading' | 'success' | 'error' | 'cancelled';

export default function PortalGoCardlessCompletePage() {
  return (
    <Suspense fallback={null}>
      <PortalGoCardlessCompleteContent />
    </Suspense>
  );
}

function PortalGoCardlessCompleteContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('');
  const [portalToken, setPortalToken] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const raw = sessionStorage.getItem('gc_portal_mandate');
    const parsed = raw
      ? (JSON.parse(raw) as { portalToken: string; billingRequestId: string })
      : null;
    if (parsed) setPortalToken(parsed.portalToken);

    if (params.get('cancelled')) {
      setState('cancelled');
      return;
    }
    if (!parsed) {
      setState('error');
      setMessage('No se encontró la domiciliación en curso.');
      return;
    }
    completeGoCardlessMandatePortal(parsed.portalToken, parsed.billingRequestId)
      .then(() => {
        sessionStorage.removeItem('gc_portal_mandate');
        setState('success');
        setTimeout(
          () => router.push(`/portal/consume?token=${encodeURIComponent(parsed.portalToken)}`),
          1600,
        );
      })
      .catch((err: unknown) => {
        setState('error');
        setMessage(
          err instanceof ApiError ? err.body.message : 'No se pudo completar la domiciliación.',
        );
      });
  }, [params, router]);

  const backToPortal = portalToken
    ? () => router.push(`/portal/consume?token=${encodeURIComponent(portalToken)}`)
    : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          {state === 'loading' && (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Activando tu domiciliación…</p>
            </>
          )}
          {state === 'success' && (
            <>
              <CheckCircle2 className="h-8 w-8 text-green-600" />
              <p className="font-medium">Domiciliación activada</p>
              <p className="text-sm text-muted-foreground">Volviendo a tu portal…</p>
            </>
          )}
          {state === 'cancelled' && (
            <>
              <XCircle className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">Has cancelado la domiciliación</p>
              {backToPortal && (
                <Button variant="outline" onClick={backToPortal}>
                  Volver al portal
                </Button>
              )}
            </>
          )}
          {state === 'error' && (
            <>
              <XCircle className="h-8 w-8 text-red-600" />
              <p className="font-medium">No se pudo completar</p>
              <p className="text-sm text-muted-foreground">{message}</p>
              {backToPortal && (
                <Button variant="outline" onClick={backToPortal}>
                  Volver al portal
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
