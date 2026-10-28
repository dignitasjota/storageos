'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/auth/api';

/** Abre el enlace del email nuevo y confirma el cambio (un solo uso). */
export function ConfirmEmailChange({ token }: { token: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; email: string } | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    apiFetch<{ email: string }>('/email-change/confirm', {
      method: 'POST',
      json: { token: decodeURIComponent(token) },
      requiresAuth: false,
    })
      .then((r) => setState({ kind: 'ok', email: r.email }))
      .catch((err: unknown) =>
        setState({
          kind: 'error',
          message:
            err instanceof ApiError ? err.body.message : 'No se ha podido confirmar el email.',
        }),
      );
  }, [token]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Cambio de email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {state.kind === 'loading' && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Confirmando…
            </p>
          )}
          {state.kind === 'ok' && (
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              Listo: a partir de ahora entras con <strong>{state.email}</strong>.
            </p>
          )}
          {state.kind === 'error' && (
            <p className="flex items-start gap-2 text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" /> {state.message}
            </p>
          )}
          {state.kind !== 'loading' && (
            <Button asChild>
              <Link href="/login">Ir a iniciar sesión</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
