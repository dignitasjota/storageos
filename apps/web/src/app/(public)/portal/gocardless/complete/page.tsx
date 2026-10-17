'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('portal.gocardless');
  const router = useRouter();
  const params = useSearchParams();
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const raw = sessionStorage.getItem('gc_portal_mandate');
    const parsed = raw
      ? (JSON.parse(raw) as { portalToken: string; billingRequestId: string })
      : null;

    if (params.get('cancelled')) {
      setState('cancelled');
      return;
    }
    if (!parsed) {
      setState('error');
      setMessage(t('notFound'));
      return;
    }
    completeGoCardlessMandatePortal(parsed.portalToken, parsed.billingRequestId)
      .then(() => {
        sessionStorage.removeItem('gc_portal_mandate');
        setState('success');
        setTimeout(() => router.push('/portal/consume'), 1600);
      })
      .catch((err: unknown) => {
        setState('error');
        setMessage(err instanceof ApiError ? err.body.message : t('errorFallback'));
      });
    // Una sola ejecución (ref): `t` no cambia el resultado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, router]);

  // La sesión del portal está guardada en el navegador: basta con volver.
  const backToPortal = () => router.push('/portal/consume');

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          {state === 'loading' && (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('loading')}</p>
            </>
          )}
          {state === 'success' && (
            <>
              <CheckCircle2 className="h-8 w-8 text-green-600" />
              <p className="font-medium">{t('successTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('successBody')}</p>
            </>
          )}
          {state === 'cancelled' && (
            <>
              <XCircle className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">{t('cancelledTitle')}</p>
              <Button variant="outline" onClick={backToPortal}>
                {t('back')}
              </Button>
            </>
          )}
          {state === 'error' && (
            <>
              <XCircle className="h-8 w-8 text-red-600" />
              <p className="font-medium">{t('errorTitle')}</p>
              <p className="text-sm text-muted-foreground">{message}</p>
              <Button variant="outline" onClick={backToPortal}>
                {t('back')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
