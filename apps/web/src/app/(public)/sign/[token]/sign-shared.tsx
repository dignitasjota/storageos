'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  ContractSignViewDto,
  PortalChargeResultDto,
  PortalInvoiceDto,
  SetupIntentResponseDto,
  SignResultDto,
} from '@storageos/shared';

import { FunnelSteps } from '@/app/(public)/s/[slug]/funnel-steps';
import { trackEvent } from '@/app/(public)/s/[slug]/google-analytics';
import { type PublicWebLocale } from '@/app/(public)/s/[slug]/i18n/messages';
import { formatPrice } from '@/app/(public)/s/[slug]/templates';
import { StripeSetupForm } from '@/components/billing/stripe-setup-form';
import { SignaturePad } from '@/components/move-in/signature-pad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { fetchPortalRedsysRedirect, submitRedsysForm } from '@/lib/payments/redsys';

/**
 * Página de firma de contrato (`/sign/[token]` y `/sign/[token]/l/[locale]`).
 * El marco `TenantWebChrome` lo pone el `page.tsx` (Server Component) — este
 * componente ya no lo envuelve. `initialView`/`initialError` los precarga el
 * servidor (`get-sign-view.ts`) para no repetir el fetch en cliente al montar.
 */
export function SignPageBody({
  token,
  locale,
  initialView = null,
  initialError = null,
}: {
  token: string;
  locale: PublicWebLocale;
  initialView?: ContractSignViewDto | null;
  initialError?: string | null;
}) {
  const t = useTranslations('publicWeb.sign');
  const tFunnel = useTranslations('publicWeb.funnel');
  const [view, setView] = useState<ContractSignViewDto | null>(initialView);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [method, setMethod] = useState<'drawn' | 'typed'>('drawn');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [signerName, setSignerName] = useState('');
  const [accept, setAccept] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SignResultDto | null>(null);
  const [pending, setPending] = useState<PortalInvoiceDto[]>([]);

  useEffect(() => {
    // Ya resuelto en servidor (caso normal) — no repetir el fetch en cliente.
    if (initialView || initialError) return;
    apiFetch<ContractSignViewDto>(`/public/move-in/sign/${token}`, { requiresAuth: false })
      .then((v) => {
        setView(v);
        setSignerName(v.customerName);
      })
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.body.message : t('invalidFallback')),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      trackEvent('sign_completed');
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
      toast.error(err instanceof ApiError ? err.body.message : t('submitError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <Centered>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('invalidTitle')}</CardTitle>
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

  const brandColor = view.brandColor ?? undefined;

  if (result || view.alreadySigned) {
    return (
      <ContentShell>
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-green-600" /> {t('signedTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {t('signedBody', { contractNumber: view.contractNumber, unitCode: view.unitCode })}
            </p>
            {pending.length > 0 && result?.portalToken ? (
              <BookingPayment
                portalToken={result.portalToken}
                invoice={pending[0]!}
                locale={locale}
              />
            ) : (
              <p className="text-muted-foreground">{t('emailNotice')}</p>
            )}
          </CardContent>
        </Card>
      </ContentShell>
    );
  }

  const canSubmit =
    accept &&
    signerName.trim().length >= 2 &&
    (method === 'drawn' ? !!drawn : typed.trim().length >= 2);

  return (
    <ContentShell>
      <FunnelSteps
        current={2}
        total={2}
        label={tFunnel('stepSign')}
        stepOfLabel={tFunnel('stepOf', { current: 2, total: 2 })}
      />
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Desglose de precio con IVA ANTES de firmar (evita sorpresa en el
              paso de pago). El alquiler lleva IVA 21%; la fianza es una garantía
              sin IVA. */}
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('monthlyFee')}</span>
              <span className="font-semibold tabular-nums">
                {formatPrice(view.priceMonthly * 1.21, locale)}
              </span>
            </div>
            {view.depositAmount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('deposit')}</span>
                <span className="font-semibold tabular-nums">
                  {formatPrice(view.depositAmount, locale)}
                </span>
              </div>
            )}
            <div className="mt-1 border-t pt-1.5 flex items-center justify-between">
              <span className="font-medium">{t('toPayNow')}</span>
              <span className="font-semibold tabular-nums">
                {formatPrice(view.priceMonthly * 1.21 + view.depositAmount, locale)}
              </span>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">{t('prorationNote')}</p>
          </div>

          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
            {view.termsText}
          </pre>

          <div className="space-y-1">
            <Label htmlFor="sign-signer-name">{t('signerNameLabel')}</Label>
            <Input
              id="sign-signer-name"
              autoComplete="name"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
            />
          </div>

          <div className="flex gap-2 text-sm">
            <Button
              type="button"
              variant={method === 'drawn' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMethod('drawn')}
            >
              {t('drawSignature')}
            </Button>
            <Button
              type="button"
              variant={method === 'typed' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMethod('typed')}
            >
              {t('typeSignature')}
            </Button>
          </div>

          {method === 'drawn' ? (
            <SignaturePad
              onChange={setDrawn}
              emptyLabel={t('signatureEmpty')}
              filledLabel={t('signatureFilled')}
              clearLabel={t('signatureClear')}
            />
          ) : (
            <div className="space-y-1">
              <Label htmlFor="sign-typed">{t('typeSignatureLabel')}</Label>
              <Input id="sign-typed" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}

          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={accept} onCheckedChange={(v) => setAccept(v === true)} />
            <span>{t('acceptTerms')}</span>
          </label>

          <Button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className={brandColor ? 'w-full text-white' : 'w-full'}
            style={brandColor ? { backgroundColor: brandColor } : undefined}
          >
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t('submit')}
          </Button>
        </CardContent>
      </Card>
    </ContentShell>
  );
}

/**
 * Contenedor centrado del contenido de firma. El marco `TenantWebChrome`
 * (header/footer con la marca del tenant) lo pone el `page.tsx` (Server
 * Component) que envuelve a `SignPageBody` — este solo aporta el ancho
 * máximo y el padding del contenido interno.
 */
function ContentShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-lg px-4 py-10">{children}</div>;
}

/**
 * Pago obligatorio de la 1ª factura tras firmar (reserva online): tarjeta vía
 * Stripe o Redsys. Al pagar, el acceso (PIN) se emite (listener invoice_paid).
 */
function BookingPayment({
  portalToken,
  invoice,
  locale,
}: {
  portalToken: string;
  invoice: PortalInvoiceDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.sign');
  const [paid, setPaid] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [busy, setBusy] = useState(false);

  const auth = { Authorization: `Bearer ${portalToken}` };

  if (paid) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-3 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
        {t('paymentPaid')}
      </div>
    );
  }
  if (processing) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-muted-foreground">
        {t('paymentProcessing')}
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
      toast.error(err instanceof ApiError ? err.body.message : t('paymentStartError'));
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
      trackEvent('payment_completed');
      setPaid(true);
      toast.success(t('paymentSuccessToast'));
    } else if (result.status === 'processing') {
      setProcessing(true);
    } else {
      toast.error(t('paymentFailed'));
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="font-medium">
        {t('firstInvoice', {
          number: invoice.invoiceNumber,
          amount: formatPrice(invoice.amountPending, locale),
        })}
      </p>
      {setupIntent ? (
        <StripeSetupForm
          clientSecret={setupIntent.clientSecret}
          publishableKey={setupIntent.publishableKey}
          submitLabel={t('payAmount', { amount: formatPrice(invoice.amountPending, locale) })}
          onConfirmed={onConfirmed}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Button onClick={startStripe} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t('payWithCard')}
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                submitRedsysForm(await fetchPortalRedsysRedirect(portalToken, invoice.id));
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : t('redsysUnavailable'));
              }
            }}
          >
            {t('payWithRedsys')}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('paymentEmailNote')}</p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
