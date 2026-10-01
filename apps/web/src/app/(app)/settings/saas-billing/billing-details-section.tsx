'use client';

import { isValidSpanishTaxId } from '@storageos/shared';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useSaasBillingDetails, useUpdateSaasBillingDetails } from '@/lib/saas-billing/hooks';

type Form = {
  legalName: string;
  taxId: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  billingEmail: string;
};

/**
 * Datos fiscales del tenant (razón social, NIF y domicilio) que aparecen en las
 * facturas de su suscripción. Sin ellos la factura no es completa.
 */
export function BillingDetailsSection() {
  const { data } = useSaasBillingDetails();
  const update = useUpdateSaasBillingDetails();
  const [form, setForm] = useState<Form | null>(null);

  if (data && !form) {
    setForm({
      legalName: data.legalName ?? '',
      taxId: data.taxId ?? '',
      address: data.address ?? '',
      city: data.city ?? '',
      postalCode: data.postalCode ?? '',
      country: data.country,
      billingEmail: data.billingEmail ?? '',
    });
  }
  if (!data || !form) return null;

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const taxIdInvalid =
    form.country.toUpperCase() === 'ES' &&
    form.taxId.trim() !== '' &&
    !isValidSpanishTaxId(form.taxId);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync({
        legalName: form.legalName,
        taxId: form.taxId,
        address: form.address,
        city: form.city,
        postalCode: form.postalCode,
        country: form.country.toUpperCase(),
        billingEmail: form.billingEmail,
      });
      toast.success('Datos de facturación guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar.');
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Datos de facturación</h2>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Datos fiscales de tu empresa</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Aparecen en las facturas de tu suscripción a TrasterOS. La razón social, el NIF y el
            domicilio fiscal son obligatorios para que la factura sea completa (y deducible).
          </p>
          {data.missing.length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Faltan: {data.missing.join(', ')}. Complétalos antes del próximo cobro.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label>Razón social</Label>
              <Input value={form.legalName} onChange={(e) => set({ legalName: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>NIF / CIF</Label>
              <Input value={form.taxId} onChange={(e) => set({ taxId: e.target.value })} />
              {taxIdInvalid && <p className="text-xs text-destructive">NIF o CIF no válido.</p>}
            </div>
            <div className="space-y-1">
              <Label>Email para las facturas</Label>
              <Input
                type="email"
                value={form.billingEmail}
                onChange={(e) => set({ billingEmail: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Domicilio fiscal</Label>
              <Input value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Código postal</Label>
              <Input
                value={form.postalCode}
                onChange={(e) => set({ postalCode: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Población</Label>
              <Input value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>País (código)</Label>
              <Input
                value={form.country}
                maxLength={2}
                onChange={(e) => set({ country: e.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Los cambios se aplican a las facturas que se emitan a partir de ahora; las ya emitidas
            no cambian.
          </p>
          <div className="flex justify-end">
            <Button onClick={() => void onSave()} disabled={update.isPending || taxIdInvalid}>
              {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
