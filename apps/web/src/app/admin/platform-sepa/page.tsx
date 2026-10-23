'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAdminPlatformSepaSettings, useUpdatePlatformSepaSettings } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

export default function PlatformSepaPage() {
  const canEdit = useIsSuperadmin();
  const settings = useAdminPlatformSepaSettings();
  const update = useUpdatePlatformSepaSettings();

  const [creditorName, setCreditorName] = useState('');
  const [creditorId, setCreditorId] = useState('');
  const [creditorIban, setCreditorIban] = useState('');
  const [creditorBic, setCreditorBic] = useState('');
  const [creditorAddress, setCreditorAddress] = useState('');
  const [creditorPostalCode, setCreditorPostalCode] = useState('');
  const [creditorCity, setCreditorCity] = useState('');
  const [prenoticeDays, setPrenoticeDays] = useState(5);
  const [loaded, setLoaded] = useState(false);

  const s = settings.data;
  if (s && !loaded) {
    setCreditorName(s.creditorName);
    setCreditorId(s.creditorId);
    setCreditorBic(s.creditorBic ?? '');
    setCreditorAddress(s.creditorAddress ?? '');
    setCreditorPostalCode(s.creditorPostalCode ?? '');
    setCreditorCity(s.creditorCity ?? '');
    setPrenoticeDays(s.prenoticeDays);
    setLoaded(true);
  }

  async function save(enabled: boolean) {
    if (!s) return;
    if (!creditorName.trim() || !creditorId.trim()) {
      toast.error('Indica el nombre y el identificador del acreedor.');
      return;
    }
    if (!s.configured && !creditorIban.trim()) {
      toast.error('Indica el IBAN de la cuenta (p.ej. BBVA).');
      return;
    }
    try {
      await update.mutateAsync({
        creditorName,
        creditorId,
        // El IBAN solo se envía si se reescribe; si no, el backend conserva el actual.
        ...(creditorIban.trim() ? { creditorIban: creditorIban.trim() } : {}),
        creditorBic,
        enabled,
        creditorAddress: creditorAddress.trim(),
        creditorPostalCode: creditorPostalCode.trim(),
        creditorCity: creditorCity.trim(),
        prenoticeDays,
      });
      toast.success('Configuración SEPA de la plataforma guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'IBAN no válido.');
    }
  }

  if (!s) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Domiciliación SEPA (SaaS)</h1>
        <p className="text-sm text-muted-foreground">
          Cuenta acreedora (p.ej. BBVA) contra la que se domicilia la cuota de los tenants en modo
          de cobro «SEPA». Una única cuenta para todos — cambiarla afecta a todos los tenants en ese
          modo por igual. Distinta de la card «Remesas SEPA» de cada tenant, que es la suya propia
          para cobrar a sus inquilinos.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Acreedor de la plataforma</CardTitle>
            <Badge variant={s.enabled ? 'default' : 'outline'}>
              {s.enabled ? 'Activado' : 'Desactivado'}
            </Badge>
          </div>
          <CardDescription>
            El IBAN se guarda cifrado.
            {s.configured && s.creditorIbanLast4 && ` IBAN actual: ····${s.creditorIbanLast4}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Nombre del acreedor</label>
              <Input
                value={creditorName}
                onChange={(e) => setCreditorName(e.target.value)}
                placeholder="TrasterOS SL"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Identificador del acreedor</label>
              <Input
                value={creditorId}
                onChange={(e) => setCreditorId(e.target.value)}
                placeholder="ES97ZZZB12345678"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                IBAN {s.configured && '(reescribir para cambiar)'}
              </label>
              <Input
                value={creditorIban}
                onChange={(e) => setCreditorIban(e.target.value)}
                placeholder={
                  s.configured ? `····${s.creditorIbanLast4}` : 'ES91 2100 0418 4502 0005 1332'
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">BIC (opcional)</label>
              <Input
                value={creditorBic}
                onChange={(e) => setCreditorBic(e.target.value)}
                placeholder="BBVAESMMXXX"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-sm font-medium">Domicilio del acreedor</label>
              <Input
                value={creditorAddress}
                onChange={(e) => setCreditorAddress(e.target.value)}
                placeholder="Calle y número"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={creditorPostalCode}
                  onChange={(e) => setCreditorPostalCode(e.target.value)}
                  placeholder="Código postal"
                />
                <Input
                  value={creditorCity}
                  onChange={(e) => setCreditorCity(e.target.value)}
                  placeholder="Ciudad"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Sale en la orden de domiciliación que firman los tenants. Sin domicilio no pueden
                firmarla.
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Preaviso de cada cargo (días)</label>
              <Input
                type="number"
                min={1}
                max={30}
                value={prenoticeDays}
                onChange={(e) =>
                  setPrenoticeDays(Math.min(30, Math.max(1, Number(e.target.value) || 5)))
                }
              />
              <p className="text-xs text-muted-foreground">
                Queda pactado en el mandato que firma cada tenant (en vez de los 14 días por
                defecto). Cambiarlo no afecta a los mandatos ya firmados: avisa con el plazo que
                firmaron.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => save(s.enabled)} disabled={update.isPending || !canEdit}>
              Guardar
            </Button>
            <Button
              variant={s.enabled ? 'destructive' : 'outline'}
              onClick={() => save(!s.enabled)}
              disabled={update.isPending || !canEdit}
            >
              {s.enabled ? 'Desactivar' : 'Activar'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Link href="/admin/platform-sepa/remittances" className="text-sm text-primary underline">
        Ver remesas SEPA →
      </Link>
    </div>
  );
}
