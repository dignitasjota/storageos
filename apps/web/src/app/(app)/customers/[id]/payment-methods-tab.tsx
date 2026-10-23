'use client';

import { Copy, CreditCard, Download, Landmark, Loader2, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PaymentMethodDto, SetupIntentResponseDto } from '@storageos/shared';

import { StripeSetupForm } from '@/components/billing/stripe-setup-form';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, apiFetchBlob } from '@/lib/auth/api';
import {
  useCreateSetupIntent,
  usePaymentOptions,
  useCustomerPaymentMethods,
  useRegisterPaymentMethod,
  useRemovePaymentMethod,
} from '@/lib/billing/hooks';
import { localDateString } from '@/lib/dates';
import { useGoCardlessSettings, useStartGoCardlessMandate } from '@/lib/payments/gocardless';
import {
  useCancelSepaMandate,
  useCreateSepaMandate,
  useResendMandateSigning,
  useSepaMandates,
} from '@/lib/sepa/hooks';

export function CustomerPaymentMethodsTab({ customerId }: { customerId: string }) {
  const ask = useConfirm();
  const methods = useCustomerPaymentMethods(customerId);
  const createSetupIntent = useCreateSetupIntent();
  const paymentOptions = usePaymentOptions();
  const remove = useRemovePaymentMethod();
  const gcSettings = useGoCardlessSettings();
  const startGoCardless = useStartGoCardlessMandate();
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function startGoCardlessMandate() {
    try {
      const res = await startGoCardless.mutateAsync(customerId);
      sessionStorage.setItem(
        'gc_mandate',
        JSON.stringify({ customerId, billingRequestId: res.billingRequestId }),
      );
      window.location.href = res.authorisationUrl;
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se pudo iniciar la domiciliación.',
      );
    }
  }

  async function openAddDialog() {
    try {
      const intent = await createSetupIntent.mutateAsync(customerId);
      setSetupIntent(intent);
      setDialogOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo iniciar el alta.');
    }
  }

  async function handleRemove(pm: PaymentMethodDto) {
    if (!(await ask({ title: `¿Eliminar el método ${formatLabel(pm)}?`, destructive: true })))
      return;
    try {
      await remove.mutateAsync({ id: pm.id, customerId });
      toast.success('Método de pago eliminado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo eliminar.');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Métodos de pago</CardTitle>
          <div className="flex gap-2">
            {gcSettings.data?.enabled && (
              <Button
                variant="outline"
                onClick={startGoCardlessMandate}
                disabled={startGoCardless.isPending}
              >
                {startGoCardless.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Landmark className="mr-1 h-4 w-4" />
                )}
                Domiciliar con GoCardless
              </Button>
            )}
            {paymentOptions.data?.cardPayments && (
              <Button onClick={openAddDialog} disabled={createSetupIntent.isPending}>
                {createSetupIntent.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-4 w-4" />
                )}
                Añadir método de pago
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {methods.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !methods.data?.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sin métodos de pago. Añade un IBAN (SEPA) o una tarjeta para poder cobrar las facturas
              automáticamente.
            </p>
          ) : (
            <ul className="divide-y">
              {methods.data.map((pm) => (
                <li key={pm.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3">
                    {pm.type === 'sepa_debit' ? (
                      <Landmark className="h-5 w-5 text-muted-foreground" />
                    ) : (
                      <CreditCard className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{formatLabel(pm)}</p>
                      <p className="text-xs text-muted-foreground">
                        {pm.type === 'sepa_debit'
                          ? `Domiciliación SEPA${pm.mandateReference ? ` · mandato ${pm.mandateReference}` : ''}`
                          : pm.expMonth && pm.expYear
                            ? `Caduca ${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}`
                            : 'Tarjeta'}
                      </p>
                    </div>
                    {pm.isDefault && <Badge variant="secondary">Predeterminado</Badge>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void handleRemove(pm)}
                    disabled={remove.isPending}
                    aria-label="Eliminar método de pago"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>

        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setSetupIntent(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Añadir método de pago</DialogTitle>
              <DialogDescription>
                IBAN (domiciliación SEPA) o tarjeta. Para SEPA, el cliente debe haber aceptado el
                mandato de domiciliación (firmado en el contrato o por escrito).
              </DialogDescription>
            </DialogHeader>
            {setupIntent && (
              <AddPaymentMethodForm
                customerId={customerId}
                setupIntent={setupIntent}
                onDone={() => {
                  setDialogOpen(false);
                  setSetupIntent(null);
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      </Card>
      <SepaMandateCard customerId={customerId} />
    </div>
  );
}

function SepaMandateCard({ customerId }: { customerId: string }) {
  const ask = useConfirm();
  const mandates = useSepaMandates(customerId);
  const create = useCreateSepaMandate();
  const cancel = useCancelSepaMandate();
  const resend = useResendMandateSigning();
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [onPaper, setOnPaper] = useState(false);
  const [signedAt, setSignedAt] = useState(localDateString());
  const [link, setLink] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const active = (mandates.data ?? []).find((m) => m.status === 'active');
  const expired = !active ? (mandates.data ?? []).find((m) => m.status === 'expired') : undefined;

  async function add() {
    if (!iban.trim()) {
      toast.error('Indica el IBAN del cliente.');
      return;
    }
    try {
      const m = await create.mutateAsync({
        customerId,
        iban: iban.trim(),
        bic: bic.trim() || undefined,
        signedOutside: onPaper,
        ...(onPaper ? { signedAt } : {}),
      });
      setIban('');
      setBic('');
      setLink(m.signingUrl ?? null);
      toast.success(
        onPaper
          ? 'Mandato registrado.'
          : 'Mandato creado. Le hemos enviado al inquilino el enlace para firmarlo.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'IBAN no válido.');
    }
  }

  async function resendLink(id: string) {
    try {
      const m = await resend.mutateAsync(id);
      setLink(m.signingUrl ?? null);
      toast.success('Enlace reenviado al inquilino.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reenviar.');
    }
  }

  async function download(id: string, reference: string) {
    setDownloading(true);
    try {
      const blob = await apiFetchBlob(`/sepa/mandates/${id}/document`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mandato-${reference}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('No se pudo descargar el mandato.');
    } finally {
      setDownloading(false);
    }
  }

  async function revoke(id: string) {
    if (!(await ask({ title: '¿Cancelar el mandato SEPA?', destructive: true }))) return;
    try {
      await cancel.mutateAsync(id);
      setLink(null);
      toast.success('Mandato cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" /> Mandato SEPA (domiciliación)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {active ? (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="text-sm">
                <p className="font-medium">
                  IBAN ····{active.ibanLast4}{' '}
                  <Badge variant="secondary" className="ml-1">
                    {active.sequenceType}
                  </Badge>{' '}
                  {active.signatureStatus === 'pending' ? (
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      Pendiente de firma
                    </Badge>
                  ) : active.signatureStatus === 'signed' ? (
                    <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      Firmado
                    </Badge>
                  ) : (
                    <Badge variant="outline">Firmado en papel</Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Ref {active.reference}
                  {active.signatureStatus === 'signed' && active.signedAtTimestamp
                    ? ` · firmado por ${active.signedByName ?? 'el inquilino'} el ${new Date(active.signedAtTimestamp).toLocaleString('es-ES')}`
                    : active.signatureStatus === 'external'
                      ? ` · firmado el ${active.signedAt}`
                      : ' · no entra en las remesas hasta que lo firme'}
                  {active.signatureStatus !== 'pending' &&
                    ` · caduca el ${active.expiresOn} si no se cobra nada antes`}
                </p>
              </div>
              <div className="flex gap-1">
                {active.signatureStatus === 'pending' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resendLink(active.id)}
                    disabled={resend.isPending}
                  >
                    <Send className="mr-1 h-4 w-4" /> Reenviar enlace
                  </Button>
                )}
                {active.signatureStatus === 'signed' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => download(active.id, active.reference)}
                    disabled={downloading}
                  >
                    <Download className="mr-1 h-4 w-4" /> Mandato
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(active.id)}
                  aria-label="Cancelar mandato"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {active.signatureStatus === 'pending' && link && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Enlace para firmar (también le ha llegado por correo; puedes abrirlo en una tablet
                  si está en el local):
                </p>
                <div className="flex gap-2">
                  <Input readOnly value={link} className="font-mono text-xs" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(link);
                      toast.success('Enlace copiado.');
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {expired && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                Su mandato {expired.reference} caducó el {expired.expiresOn} (36 meses sin cobros).
                Para volver a domiciliar tiene que firmar uno nuevo.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Para domiciliar sus recibos, el inquilino tiene que firmar la orden de domiciliación
              (lo exige el banco). Le enviaremos un enlace para firmarla desde el móvil.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                placeholder="IBAN ES91…"
                value={iban}
                onChange={(e) => setIban(e.target.value)}
              />
              <Input
                placeholder="BIC (opcional)"
                value={bic}
                onChange={(e) => setBic(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={onPaper}
                onChange={(e) => setOnPaper(e.target.checked)}
              />
              Ya lo firmó en papel (lo guardas tú)
            </label>
            {onPaper && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Fecha de firma</span>
                <Input
                  type="date"
                  className="w-44"
                  value={signedAt}
                  onChange={(e) => setSignedAt(e.target.value)}
                />
              </div>
            )}
            <Button size="sm" onClick={add} disabled={create.isPending}>
              <Plus className="mr-1 h-4 w-4" />
              {onPaper ? 'Registrar mandato' : 'Enviar para firmar'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Alta de método de pago (staff): `StripeSetupForm` compartido + checkbox
 * de predeterminado. `type: 'card'` es solo fallback — el backend deriva
 * el tipo real (card / sepa_debit) consultando el payment method en Stripe.
 */
function AddPaymentMethodForm({
  customerId,
  setupIntent,
  onDone,
}: {
  customerId: string;
  setupIntent: SetupIntentResponseDto;
  onDone: () => void;
}) {
  const register = useRegisterPaymentMethod();
  const [isDefault, setIsDefault] = useState(true);

  return (
    <StripeSetupForm
      clientSecret={setupIntent.clientSecret}
      publishableKey={setupIntent.publishableKey}
      stripeAccount={setupIntent.stripeAccount}
      onConfirmed={async (gatewayToken) => {
        try {
          await register.mutateAsync({
            customerId,
            type: 'card',
            gatewayToken,
            gatewayCustomerId: setupIntent.customerId,
            isDefault,
          });
          toast.success('Método de pago guardado.');
          onDone();
        } catch (err) {
          toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
        }
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
        Usar como método de pago predeterminado
      </label>
    </StripeSetupForm>
  );
}

function formatLabel(pm: PaymentMethodDto): string {
  if (pm.type === 'sepa_debit') {
    return `IBAN •••• ${pm.last4 ?? '????'}`;
  }
  const brand = pm.brand ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1) : 'Tarjeta';
  return `${brand} •••• ${pm.last4 ?? '????'}`;
}
