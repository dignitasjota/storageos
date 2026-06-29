'use client';

import { CreditCard, Landmark, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PaymentMethodDto, SetupIntentResponseDto } from '@storageos/shared';

import { StripeSetupForm } from '@/components/billing/stripe-setup-form';
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
import { ApiError } from '@/lib/auth/api';
import {
  useCreateSetupIntent,
  useCustomerPaymentMethods,
  useRegisterPaymentMethod,
  useRemovePaymentMethod,
} from '@/lib/billing/hooks';
import { useGoCardlessSettings, useStartGoCardlessMandate } from '@/lib/payments/gocardless';
import { useCancelSepaMandate, useCreateSepaMandate, useSepaMandates } from '@/lib/sepa/hooks';

export function CustomerPaymentMethodsTab({ customerId }: { customerId: string }) {
  const methods = useCustomerPaymentMethods(customerId);
  const createSetupIntent = useCreateSetupIntent();
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
    if (!window.confirm(`¿Eliminar el método ${formatLabel(pm)}?`)) return;
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
            <Button onClick={openAddDialog} disabled={createSetupIntent.isPending}>
              {createSetupIntent.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Añadir método de pago
            </Button>
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
  const mandates = useSepaMandates(customerId);
  const create = useCreateSepaMandate();
  const cancel = useCancelSepaMandate();
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [signedAt, setSignedAt] = useState(new Date().toISOString().slice(0, 10));

  const active = (mandates.data ?? []).find((m) => m.status === 'active');

  async function add() {
    if (!iban.trim()) {
      toast.error('Indica el IBAN del cliente.');
      return;
    }
    try {
      await create.mutateAsync({
        customerId,
        iban: iban.trim(),
        bic: bic.trim() || undefined,
        signedAt,
      });
      setIban('');
      setBic('');
      toast.success('Mandato SEPA registrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'IBAN no válido.');
    }
  }

  async function revoke(id: string) {
    if (!confirm('¿Cancelar el mandato SEPA?')) return;
    try {
      await cancel.mutateAsync(id);
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
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="text-sm">
              <p className="font-medium">
                IBAN ····{active.ibanLast4}{' '}
                <Badge variant="secondary" className="ml-1">
                  {active.sequenceType}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">
                Ref {active.reference} · firmado {active.signedAt}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => revoke(active.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Registra el mandato para poder domiciliar las facturas de este cliente en las remesas
              SEPA.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
              <Input type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} />
            </div>
            <Button size="sm" onClick={add} disabled={create.isPending}>
              <Plus className="mr-1 h-4 w-4" /> Registrar mandato
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
