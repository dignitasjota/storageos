'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminPlatformBillingSettings,
  useUpdatePlatformBillingSettings,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type Form = {
  legalName: string;
  taxId: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  email: string;
  taxRate: number;
  seriesPrefix: string;
  enabled: boolean;
};

export default function PlatformBillingPage() {
  const { data } = useAdminPlatformBillingSettings();
  const update = useUpdatePlatformBillingSettings();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data && !form) {
      setForm({
        legalName: data.legalName,
        taxId: data.taxId,
        address: data.address ?? '',
        city: data.city ?? '',
        postalCode: data.postalCode ?? '',
        country: data.country,
        email: data.email ?? '',
        taxRate: data.taxRate,
        seriesPrefix: data.seriesPrefix,
        enabled: data.enabled,
      });
    }
  }, [data, form]);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync({
        legalName: form.legalName,
        taxId: form.taxId,
        address: form.address || null,
        city: form.city || null,
        postalCode: form.postalCode || null,
        country: form.country.toUpperCase(),
        email: form.email || null,
        taxRate: form.taxRate,
        seriesPrefix: form.seriesPrefix,
        enabled: form.enabled,
      });
      toast.success('Datos de facturación guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (!form) return null;
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Facturación del SaaS</h1>
        <p className="text-sm text-muted-foreground">
          Datos fiscales del emisor (StorageOS) para las facturas de suscripción que emites a los
          tenants. Actívala para poder emitir facturas.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Datos del emisor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>Razón social</Label>
              <Input value={form.legalName} onChange={(e) => set({ legalName: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>NIF/CIF</Label>
              <Input value={form.taxId} onChange={(e) => set({ taxId: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input value={form.email} onChange={(e) => set({ email: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Dirección</Label>
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
              <Label>Ciudad</Label>
              <Input value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>País (ISO)</Label>
              <Input
                value={form.country}
                maxLength={2}
                onChange={(e) => set({ country: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>IVA (%)</Label>
              <Input
                type="number"
                value={form.taxRate}
                onChange={(e) => set({ taxRate: e.target.valueAsNumber || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label>Prefijo de serie</Label>
              <Input
                value={form.seriesPrefix}
                onChange={(e) => set({ seriesPrefix: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Facturación del SaaS activada (se emiten facturas al registrar un pago cobrado)
          </label>
          <div className="flex justify-end">
            <Button onClick={onSave} disabled={update.isPending}>
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
