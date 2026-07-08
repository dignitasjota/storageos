'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  ContractSignViewDto,
  PortalChargeResultDto,
  PortalInvoiceDto,
  SetupIntentResponseDto,
  SignResultDto,
} from '@storageos/shared';

import { StripeSetupForm } from '@/components/billing/stripe-setup-form';
import { SignaturePad } from '@/components/move-in/signature-pad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { fetchPortalRedsysRedirect, submitRedsysForm } from '@/lib/payments/redsys';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export default function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [view, setView] = useState<ContractSignViewDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<'drawn' | 'typed'>('drawn');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [signerName, setSignerName] = useState('');
  const [accept, setAccept] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SignResultDto | null>(null);
  const [pending, setPending] = useState<PortalInvoiceDto[]>([]);

  useEffect(() => {
    apiFetch<ContractSignViewDto>(`/public/move-in/sign/${token}`, { requiresAuth: false })
      .then((v) => {
        setView(v);
        setSignerName(v.customerName);
      })
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.body.message : 'Enlace inválido o caducado'),
      );
  }, [token]);

  async function submit() {
    setSubmitting(true);
    try {
      const res = await apiFetch<SignResultDto>(`/public/move-in/sign/${token}`, {
        method: 'POST',
        requiresAuth: false,
        json: {
          signerName,
          method,
          accept: true,
          ...(method === 'drawn' ? { signatureImage: drawn } : { typedSignature: typed }),
        },
      });
      setResult(res);
      if (res.portalToken) {
        try {
          const invoices = await apiFetch<PortalInvoiceDto[]>('/portal/me/invoices', {
            requiresAuth: false,
            headers: { Authorization: `Bearer ${res.portalToken}` },
          });
          setPending(invoices.filter((i) => i.status === 'issued' || i.status === 'overdue'));
        } catch {
          /* el pago es opcional aquí */
        }
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo firmar.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Enlace no válido</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{loadError}</CardContent>
        </Card>
      </Centered>
    );
  }

  if (!view) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  if (result || view.alreadySigned) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-green-600" /> Contrato firmado
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              ¡Gracias! Tu contrato <strong>{view.contractNumber}</strong> queda firmado. Para
              activar tu acceso al trastero <strong>{view.unitCode}</strong>, completa el pago de tu
              primera factura.
            </p>
            {pending.length > 0 && result?.portalToken ? (
              <BookingPayment portalToken={result.portalToken} invoice={pending[0]!} />
            ) : (
              <p className="text-muted-foreground">
                Te hemos enviado un email con el enlace a tu portal para completar el pago.
              </p>
            )}
          </CardContent>
        </Card>
      </Centered>
    );
  }

  const canSubmit =
    accept &&
    signerName.trim().length >= 2 &&
    (method === 'drawn' ? !!drawn : typed.trim().length >= 2);

  return (
    <Centered>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Firma de contrato</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Desglose de precio con IVA ANTES de firmar (evita sorpresa en el
              paso de pago). El alquiler lleva IVA 21%; la fianza es una garantía
              sin IVA. */}
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Cuota mensual (IVA incl.)</span>
              <span className="font-semibold tabular-nums">
                {(view.priceMonthly * 1.21).toFixed(2)} €
              </span>
            </div>
            {view.depositAmount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Fianza (una vez, sin IVA)</span>
                <span className="font-semibold tabular-nums">
                  {view.depositAmount.toFixed(2)} €
                </span>
              </div>
            )}
            <div className="mt-1 border-t pt-1.5 flex items-center justify-between">
              <span className="font-medium">A pagar al activar</span>
              <span className="font-semibold tabular-nums">
                {(view.priceMonthly * 1.21 + view.depositAmount).toFixed(2)} €
              </span>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              Si entras a mitad de mes, la primera cuota se prorratea por los días.
            </p>
          </div>

          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
            {view.termsText}
          </pre>

          <div className="space-y-1">
            <Label>Nombre del firmante</Label>
            <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>

          <div className="flex gap-2 text-sm">
            <Button
              type="button"
              variant={method === 'drawn' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMethod('drawn')}
            >
              Dibujar firma
            </Button>
            <Button
              type="button"
              variant={method === 'typed' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMethod('typed')}
            >
              Escribir nombre
            </Button>
          </div>

          {method === 'drawn' ? (
            <SignaturePad onChange={setDrawn} />
          ) : (
            <div className="space-y-1">
              <Label>Escribe tu nombre completo como firma</Label>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={accept} onCheckedChange={(v) => setAccept(v === true)} />
            <span>
              He leído y acepto las condiciones del contrato. Reconozco esta firma electrónica como
              expresión de mi consentimiento.
            </span>
          </label>

          <Button onClick={submit} disabled={!canSubmit || submitting} className="w-full">
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Firmar contrato
          </Button>
        </CardContent>
      </Card>
    </Centered>
  );
}

/**
 * Pago obligatorio de la 1ª factura tras firmar (reserva online): tarjeta vía
 * Stripe o Redsys. Al pagar, el acceso (PIN) se emite (listener invoice_paid).
 */
function BookingPayment({
  portalToken,
  invoice,
}: {
  portalToken: string;
  invoice: PortalInvoiceDto;
}) {
  const [paid, setPaid] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [busy, setBusy] = useState(false);

  const auth = { Authorization: `Bearer ${portalToken}` };

  if (paid) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-3 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
        ✓ Pago completado. Tu acceso al trastero se activará en breve.
      </div>
    );
  }
  if (processing) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-muted-foreground">
        Domiciliación iniciada: tu banco la confirmará en 2-5 días hábiles y tu acceso se activará
        entonces.
      </div>
    );
  }

  async function startStripe() {
    setBusy(true);
    try {
      const intent = await apiFetch<SetupIntentResponseDto>(
        '/portal/me/payment-methods/setup-intent',
        { method: 'POST', requiresAuth: false, headers: auth },
      );
      setSetupIntent(intent);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo iniciar el pago.');
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmed(gatewayToken: string) {
    await apiFetch('/portal/me/payment-methods', {
      method: 'POST',
      requiresAuth: false,
      headers: auth,
      json: { gatewayToken, gatewayCustomerId: setupIntent?.customerId },
    });
    const result = await apiFetch<PortalChargeResultDto>(
      `/portal/me/invoices/${invoice.id}/charge`,
      { method: 'POST', requiresAuth: false, headers: auth },
    );
    if (result.status === 'succeeded') {
      setPaid(true);
      toast.success('Pago realizado. ¡Gracias!');
    } else if (result.status === 'processing') {
      setProcessing(true);
    } else {
      toast.error('El pago no se pudo completar. Inténtalo de nuevo.');
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium">
        Primera factura: {invoice.invoiceNumber} — {eur(invoice.amountPending)}
      </p>
      {setupIntent ? (
        <StripeSetupForm
          clientSecret={setupIntent.clientSecret}
          publishableKey={setupIntent.publishableKey}
          submitLabel={`Pagar ${eur(invoice.amountPending)}`}
          onConfirmed={onConfirmed}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Button onClick={startStripe} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Pagar con tarjeta
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                submitRedsysForm(await fetchPortalRedsysRedirect(portalToken, invoice.id));
              } catch (err) {
                toast.error(
                  err instanceof ApiError ? err.body.message : 'Redsys no está disponible.',
                );
              }
            }}
          >
            Pagar con Redsys
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        También recibirás un email con el enlace a tu portal para pagarla más tarde.
      </p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
