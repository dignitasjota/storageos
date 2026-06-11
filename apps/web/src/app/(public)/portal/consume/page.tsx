'use client';

import {
  type PaymentMethodDto,
  type PortalChargeResultDto,
  type PortalInvoiceDto,
  type PortalSessionDto,
  type SetupIntentResponseDto,
} from '@storageos/shared';
import { CreditCard, Download, Landmark, Loader2, Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { StripeSetupForm } from '@/components/billing/stripe-setup-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, apiFetch } from '@/lib/auth/api';

function PortalConsumeContent() {
  const params = useSearchParams();
  const token = params.get('token');
  const [session, setSession] = useState<PortalSessionDto | null>(null);
  const [invoices, setInvoices] = useState<PortalInvoiceDto[] | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);

  /** Fetch autenticado con el JWT corto del portal (no usa el auth store del staff). */
  function portalFetch<T>(
    s: PortalSessionDto,
    path: string,
    init?: { method?: string; json?: unknown },
  ) {
    return apiFetch<T>(path, {
      method: init?.method ?? 'GET',
      ...(init?.json !== undefined ? { json: init.json } : {}),
      headers: { Authorization: `Bearer ${s.accessToken}` },
      requiresAuth: false,
    });
  }

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
        const [inv, pms] = await Promise.all([
          portalFetch<PortalInvoiceDto[]>(s, '/portal/me/invoices'),
          portalFetch<PaymentMethodDto[]>(s, '/portal/me/payment-methods'),
        ]);
        if (cancelled) return;
        setInvoices(inv);
        setPaymentMethods(pms);
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
    // portalFetch es estable (no captura estado), solo depende del token.
  }, [token]);

  async function openAddDialog() {
    if (!session) return;
    setAddPending(true);
    try {
      const intent = await portalFetch<SetupIntentResponseDto>(
        session,
        '/portal/me/payment-methods/setup-intent',
        { method: 'POST' },
      );
      setSetupIntent(intent);
      setAddOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo iniciar el alta.');
    } finally {
      setAddPending(false);
    }
  }

  async function registerPaymentMethod(gatewayToken: string) {
    if (!session || !setupIntent) return;
    try {
      await portalFetch<PaymentMethodDto>(session, '/portal/me/payment-methods', {
        method: 'POST',
        json: { gatewayToken, gatewayCustomerId: setupIntent.customerId },
      });
      const pms = await portalFetch<PaymentMethodDto[]>(session, '/portal/me/payment-methods');
      setPaymentMethods(pms);
      setAddOpen(false);
      setSetupIntent(null);
      toast.success('Método de pago guardado. Ya puedes pagar tus facturas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function handlePay(invoice: PortalInvoiceDto) {
    if (!session) return;
    setPayingId(invoice.id);
    try {
      const result = await portalFetch<PortalChargeResultDto>(
        session,
        `/portal/me/invoices/${invoice.id}/charge`,
        { method: 'POST' },
      );
      if (result.status === 'processing') {
        toast.info('Pago domiciliado iniciado: tu banco lo confirmará en 2-5 días hábiles.');
      } else if (result.status === 'succeeded') {
        toast.success('Pago realizado. ¡Gracias!');
        const inv = await portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices');
        setInvoices(inv);
      } else {
        toast.error(
          result.failureReason
            ? `El pago no se completó: ${result.failureReason}`
            : 'El pago no se completó.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'no_payment_method') {
        toast.message('Añade primero un IBAN o tarjeta para poder pagar.');
        void openAddDialog();
      } else {
        toast.error(err instanceof ApiError ? err.body.message : 'No se pudo procesar el pago.');
      }
    } finally {
      setPayingId(null);
    }
  }

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
                      <Button onClick={() => void handlePay(i)} disabled={payingId !== null}>
                        {payingId === i.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Método de pago</CardTitle>
            <CardDescription>Domicilia tus recibos con tu IBAN o paga con tarjeta.</CardDescription>
          </div>
          <Button onClick={() => void openAddDialog()} disabled={addPending} variant="outline">
            {addPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-1 h-4 w-4" />
            )}
            Añadir IBAN o tarjeta
          </Button>
        </CardHeader>
        <CardContent>
          {!paymentMethods?.length ? (
            <p className="text-sm text-muted-foreground">
              Sin método de pago guardado. Añade tu IBAN para domiciliar los recibos.
            </p>
          ) : (
            <ul className="divide-y">
              {paymentMethods.map((pm) => (
                <li key={pm.id} className="flex items-center gap-3 py-3">
                  {pm.type === 'sepa_debit' ? (
                    <Landmark className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <CreditCard className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {pm.type === 'sepa_debit'
                        ? `IBAN •••• ${pm.last4 ?? '????'}`
                        : `${pm.brand ?? 'Tarjeta'} •••• ${pm.last4 ?? '????'}`}
                    </p>
                    {pm.type === 'sepa_debit' && pm.mandateReference && (
                      <p className="text-xs text-muted-foreground">Mandato {pm.mandateReference}</p>
                    )}
                  </div>
                  {pm.isDefault && <Badge variant="secondary">Predeterminado</Badge>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setSetupIntent(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Añadir método de pago</DialogTitle>
            <DialogDescription>
              Tu IBAN para domiciliación SEPA (aceptarás el mandato en este formulario) o una
              tarjeta.
            </DialogDescription>
          </DialogHeader>
          {setupIntent && (
            <StripeSetupForm
              clientSecret={setupIntent.clientSecret}
              publishableKey={setupIntent.publishableKey}
              onConfirmed={registerPaymentMethod}
            />
          )}
        </DialogContent>
      </Dialog>
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
