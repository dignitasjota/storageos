'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminPaymentSettings, useUpdateAdminPaymentSettings } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Comisión de la plataforma sobre los cobros con tarjeta de los tenants (Stripe Connect). */
export default function AdminPaymentsPage() {
  const settings = useAdminPaymentSettings();
  const update = useUpdateAdminPaymentSettings();
  const [fee, setFee] = useState('');
  const [loaded, setLoaded] = useState(false);

  const s = settings.data;
  if (s && !loaded) {
    setFee(String(s.applicationFeePct));
    setLoaded(true);
  }

  async function save() {
    const value = Number(fee.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      toast.error('La comisión debe estar entre 0 y 10 %.');
      return;
    }
    try {
      await update.mutateAsync({ applicationFeePct: value });
      toast.success('Comisión guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cobros de los tenants</h1>
        <p className="text-sm text-muted-foreground">
          Los tenants pueden conectar su propia cuenta de Stripe para cobrar con tarjeta a sus
          inquilinos. El dinero va a su cuenta; la plataforma se queda una comisión por cobro. Esta
          cuenta de Stripe es distinta de la que cobra las suscripciones.
        </p>
      </div>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Comisión por cobro</CardTitle>
          <CardDescription>
            Porcentaje de cada cobro con tarjeta que se queda la plataforma, además de la tarifa de
            Stripe. Aplica a los cobros nuevos.
            {s ? ` Tenants con Stripe conectado: ${s.connectedTenants}.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="fee">Comisión (%)</Label>
            <Input
              id="fee"
              inputMode="decimal"
              className="w-32"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
          </div>
          <Button onClick={() => void save()} disabled={update.isPending || !s}>
            Guardar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
