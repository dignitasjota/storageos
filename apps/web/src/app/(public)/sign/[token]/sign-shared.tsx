'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  ContractSignViewDto,
  PortalChargeResultDto,
  PortalInvoiceDto,
  RedsysPayMethod,
  SetupIntentResponseDto,
  SignResultDto,
} from '@storageos/shared';

import { FirstPaymentSummary } from '@/app/(public)/s/[slug]/first-payment-summary';
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
  // El nombre del inquilino ya viene en la vista precargada en el servidor.
  const [signerName, setSignerName] = useState(initialView?.customerName ?? '');
  const [accept, setAccept] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SignResultDto | null>(null);
  const [pending, setPending] = useState<PortalInvoiceDto[]>([]);
  // Vuelve al enlace tras firmar: sesión para pagar lo pendiente.
  const [payToken, setPayToken] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function loadPending(portalToken: string) {
    try {
      const invoices = await apiFetch<PortalInvoiceDto[]>('/portal/me/invoices', {
        requiresAuth: false,
        headers: { Authorization: `Bearer ${portalToken}` },
      });
      setPending(invoices.filter((i) => i.status === 'issued' || i.status === 'overdue'));
    } catch {
      /* el pago es opcional aquí */
    }
  }

  async function reloadView() {
    try {
      const v = await apiFetch<ContractSignViewDto>(`/public/move-in/sign/${token}`, {
        requiresAuth: false,
      });
      setView(v);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.body.message : t('invalidFallback'));
    }
  }

  async function openPayment() {
    setOpening(true);
    try {
      const res = await apiFetch<{ portalToken: string }>(`/public/move-in/sign/${token}/payment`, {
        method: 'POST',
        requiresAuth: false,
      });
      setPayToken(res.portalToken);
      await loadPending(res.portalToken);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('paymentStartError'));
    } finally {
      setOpening(false);
    }
  }

  useEffect(() => {
    // Ya resuelto en servidor (caso normal) — no repetir el fetch en cliente.
    if (initialView || initialError) return;
    apiFetch<ContractSignViewDto>(`/public/move-in/sign/${token}`, { requiresAuth: false })
      .then((v) => {
        setView(v);
        setSignerName((n) => n || v.customerName);
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
          // Lo que ha leído: si el contrato cambió entretanto, no se firma.
          ...(view?.termsHash ? { termsHash: view.termsHash } : {}),
        },
      });
      trackEvent('sign_completed');
      setResult(res);
      if (res.portalToken) await loadPending(res.portalToken);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'terms_changed') {
        toast.error(t('termsChanged'));
        setAccept(false);
        await reloadView();
      } else {
        toast.error(err instanceof ApiError ? err.body.message : t('submitError'));
      }
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
    const portalToken = result?.portalToken ?? payToken;
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
              {result || view.paymentPending
                ? t('signedBody', { contractNumber: view.contractNumber, unitCode: view.unitCode })
                : t('signedDoneBody', { contractNumber: view.contractNumber })}
            </p>
            {pending.length > 0 && portalToken ? (
              <BookingPayment portalToken={portalToken} invoice={pending[0]!} locale={locale} />
            ) : !result && view.paymentPending ? (
              <Button
                onClick={() => void openPayment()}
                disabled={opening}
                className={brandColor ? 'w-full text-white' : 'w-full'}
                style={brandColor ? { backgroundColor: brandColor } : undefined}
              >
                {opening && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t('payPendingButton')}
              </Button>
            ) : (
              <p className="text-muted-foreground">{t('emailNotice')}</p>
            )}
            {!result && (
              <details className="rounded-md border bg-muted/30 p-3">
                <summary className="cursor-pointer font-medium">{t('viewSignedTerms')}</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                  {view.termsText}
                </pre>
              </details>
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
          <FirstPaymentSummary quote={view.firstPayment} locale={locale} />
          {view.depositAmount > 0 && view.depositPaymentMethod === 'cash' && (
            <p className="text-xs text-muted-foreground">{t('depositCash')}</p>
          )}

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
  // Qué ofrece el TPV del tenant (Redsys + Bizum). Sin Redsys no se muestra.
  const [redsys, setRedsys] = useState<{
    enabled: boolean;
    bizumEnabled: boolean;
    cardOnFileEnabled: boolean;
  } | null>(null);
  // Pago por referencia: guardar la tarjeta para cobrar solas las próximas cuotas.
  const [saveCard, setSaveCard] = useState(true);

  // Tarjeta por Stripe: desactivada mientras no haya Stripe Connect.
  const [cardPayments, setCardPayments] = useState(false);

  const auth = { Authorization: `Bearer ${portalToken}` };

  useEffect(() => {
    apiFetch<{ cardPayments: boolean }>('/portal/me/payments/options', {
      requiresAuth: false,
      headers: { Authorization: `Bearer ${portalToken}` },
    })
      .then((o) => setCardPayments(o.cardPayments))
      .catch(() => setCardPayments(false));
  }, [portalToken]);

  useEffect(() => {
    apiFetch<{
      enabled: boolean;
      bizumEnabled: boolean;
      cardEnabled?: boolean;
      cardOnFileEnabled?: boolean;
    }>('/portal/me/redsys/enabled', {
      requiresAuth: false,
      headers: { Authorization: `Bearer ${portalToken}` },
    })
      // Con la tarjeta por Stripe, Redsys solo ofrece Bizum.
      .then((r) =>
        setRedsys({
          enabled: r.cardEnabled ?? r.enabled,
          bizumEnabled: r.bizumEnabled,
          cardOnFileEnabled: !!r.cardOnFileEnabled,
        }),
      )
      .catch(() => setRedsys(null));
  }, [portalToken]);

  async function payWithRedsys(payMethod?: RedsysPayMethod) {
    trackEvent('payment_redirect', { method: payMethod === 'bizum' ? 'bizum' : 'redsys_card' });
    try {
      submitRedsysForm(
        await fetchPortalRedsysRedirect(
          portalToken,
          invoice.id,
          payMethod,
          payMethod !== 'bizum' && !!redsys?.cardOnFileEnabled && saveCard,
        ),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('redsysUnavailable'));
    }
  }

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
          stripeAccount={setupIntent.stripeAccount}
          submitLabel={t('payAmount', { amount: formatPrice(invoice.amountPending, locale) })}
          onConfirmed={onConfirmed}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {cardPayments && (
            <Button onClick={startStripe} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t('payWithCard')}
            </Button>
          )}
          {!cardPayments && redsys && !redsys.enabled && !redsys.bizumEnabled && (
            <p className="text-sm text-muted-foreground">{t('noOnlinePayment')}</p>
          )}
          {redsys?.bizumEnabled && (
            <Button variant="outline" onClick={() => void payWithRedsys('bizum')}>
              {t('payWithBizum')}
            </Button>
          )}
          {redsys?.enabled && (
            // Con Bizum también activo, este botón fuerza tarjeta para separar métodos.
            <Button
              variant="outline"
              onClick={() => void payWithRedsys(redsys.bizumEnabled ? 'card' : undefined)}
            >
              {t('payWithRedsys')}
            </Button>
          )}
          {redsys?.enabled && redsys.cardOnFileEnabled && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={saveCard}
                onChange={(e) => setSaveCard(e.target.checked)}
              />
              {t('saveCard')}
            </label>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('paymentEmailNote')}</p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
