'use client';

import { type PortalInvoiceDto, type PortalSessionDto } from '@storageos/shared';
import { Download, Loader2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/auth/api';

function PortalConsumeContent() {
  const params = useSearchParams();
  const token = params.get('token');
  const [session, setSession] = useState<PortalSessionDto | null>(null);
  const [invoices, setInvoices] = useState<PortalInvoiceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setError('Enlace inválido');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await apiFetch<PortalSessionDto>('/portal/login/consume', {
          method: 'POST',
          json: { token },
          requiresAuth: false,
        });
        if (cancelled) return;
        setSession(s);
        const inv = await apiFetch<PortalInvoiceDto[]>('/portal/me/invoices', {
          method: 'GET',
          headers: { Authorization: `Bearer ${s.accessToken}` },
          requiresAuth: false,
        });
        if (cancelled) return;
        setInvoices(inv);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.body.message : 'Enlace inválido o caducado');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="container flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !session || !invoices) {
    return (
      <div className="container max-w-md py-12">
        <Card className="border-border/60 text-center">
          <CardHeader>
            <CardTitle>Acceso fallido</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl space-y-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hola, {session.customerName}</h1>
        <p className="text-sm text-muted-foreground">
          {session.tenantName} · {session.email}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tus facturas</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 && (
            <p className="text-sm text-muted-foreground">Aún no tienes facturas.</p>
          )}
          {invoices.length > 0 && (
            <ul className="divide-y rounded-md border">
              {invoices.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
                >
                  <div>
                    <p className="font-mono text-sm font-medium">{i.invoiceNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      Emitida {i.issueDate ?? '—'} · Vence {i.dueDate ?? '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums">
                      {i.total.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
                    </span>
                    <Badge
                      variant={
                        i.status === 'paid'
                          ? 'default'
                          : i.status === 'overdue'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {i.status}
                    </Badge>
                    {i.amountPending > 0 && (
                      <Button
                        onClick={() =>
                          toast.message(
                            'El pago online estará disponible cuando el comercio conecte Stripe.',
                          )
                        }
                      >
                        Pagar
                      </Button>
                    )}
                    {i.pdfUrl && (
                      <Button variant="outline" asChild>
                        <a href={i.pdfUrl} target="_blank" rel="noreferrer">
                          <Download className="mr-1 h-4 w-4" /> PDF
                        </a>
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function PortalConsumePage() {
  return (
    <Suspense fallback={null}>
      <PortalConsumeContent />
    </Suspense>
  );
}
