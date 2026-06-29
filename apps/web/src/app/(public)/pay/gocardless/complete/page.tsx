'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useCompleteGoCardlessMandate } from '@/lib/payments/gocardless';

type State = 'loading' | 'success' | 'error' | 'cancelled';

export default function GoCardlessCompletePage() {
  return (
    <Suspense fallback={null}>
      <GoCardlessCompleteContent />
    </Suspense>
  );
}

function GoCardlessCompleteContent() {
  const router = useRouter();
  const params = useSearchParams();
  const complete = useCompleteGoCardlessMandate();
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    if (params.get('cancelled')) {
      setState('cancelled');
      return;
    }
    const raw = sessionStorage.getItem('gc_mandate');
    if (!raw) {
      setState('error');
      setMessage('No se encontró el mandato en curso.');
      return;
    }
    const { customerId: cid, billingRequestId } = JSON.parse(raw) as {
      customerId: string;
      billingRequestId: string;
    };
    setCustomerId(cid);
    complete
      .mutateAsync({ customerId: cid, billingRequestId })
      .then(() => {
        sessionStorage.removeItem('gc_mandate');
        setState('success');
        setTimeout(() => router.push(`/customers/${cid}`), 1600);
      })
      .catch((err: unknown) => {
        setState('error');
        setMessage(err instanceof ApiError ? err.body.message : 'No se pudo completar el mandato.');
      });
  }, [complete, params, router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          {state === 'loading' && (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Confirmando la domiciliación…</p>
            </>
          )}
          {state === 'success' && (
            <>
              <CheckCircle2 className="h-8 w-8 text-green-600" />
              <p className="font-medium">Domiciliación activada</p>
              <p className="text-sm text-muted-foreground">Te llevamos a la ficha del inquilino…</p>
            </>
          )}
          {state === 'cancelled' && (
            <>
              <XCircle className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">Has cancelado la domiciliación</p>
              {customerId && (
                <Button variant="outline" onClick={() => router.push(`/customers/${customerId}`)}>
                  Volver a la ficha
                </Button>
              )}
            </>
          )}
          {state === 'error' && (
            <>
              <XCircle className="h-8 w-8 text-red-600" />
              <p className="font-medium">No se pudo completar</p>
              <p className="text-sm text-muted-foreground">{message}</p>
              {customerId && (
                <Button variant="outline" onClick={() => router.push(`/customers/${customerId}`)}>
                  Volver a la ficha
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
