'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useSepaSettings, useUpdateSepaSettings } from '@/lib/sepa/hooks';
import {
  useTenantBillingSettings,
  useUpdateTenantBillingSettings,
} from '@/lib/tenant-settings/hooks';

export function AutoChargeCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();

  if (!canConfigure) return null;
  if (settings.isLoading || !settings.data) return null;

  const enabled = settings.data.autoChargeOnIssue;

  async function toggle() {
    try {
      await update.mutateAsync({ autoChargeOnIssue: !enabled });
      toast.success(
        enabled
          ? 'Cobro automático desactivado.'
          : 'Cobro automático activado: cada factura emitida se cobrará al método predeterminado.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Cobro automático</CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>
            {enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Al emitir una factura se intenta cobrar automáticamente al método de pago predeterminado
          del cliente (tarjeta o domiciliación SEPA).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Las facturas de clientes sin método de pago guardado (o las simplificadas F2) quedan
          pendientes como hasta ahora, sin error. Los cobros SEPA tardan 2-5 días hábiles en
          confirmarse; el estado de la factura se actualiza solo.
        </p>
        <Button
          onClick={toggle}
          variant={enabled ? 'destructive' : 'default'}
          disabled={update.isPending}
        >
          {update.isPending ? 'Guardando…' : enabled ? 'Desactivar' : 'Activar cobro automático'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** IBAN para que los inquilinos paguen por transferencia (sale en el correo de la factura). */
export function TransferIbanCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();
  const [iban, setIban] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (settings.data && !ready) {
      setIban(settings.data.transferIban ?? '');
      setReady(true);
    }
  }, [settings.data, ready]);

  if (!canConfigure || !settings.data) return null;
  const saved = settings.data.transferIban ?? '';
  const changed = iban.replace(/\s+/g, '').toUpperCase() !== saved;

  async function save() {
    try {
      const res = await update.mutateAsync({ transferIban: iban.trim() });
      setIban(res.transferIban ?? '');
      toast.success(res.transferIban ? 'IBAN guardado.' : 'IBAN quitado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'IBAN no válido');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>IBAN para transferencias</CardTitle>
        <CardDescription>
          Sale en el correo de cada factura a los inquilinos que no tienen cobro automático ni
          domiciliación, junto al número de factura para que lo pongan en el concepto. Déjalo vacío
          si no aceptas transferencias.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="transfer-iban">IBAN</Label>
          <Input
            id="transfer-iban"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            placeholder="ES00 0000 0000 0000 0000 0000"
            className="font-mono text-base sm:text-sm"
          />
        </div>
        <Button onClick={() => void save()} disabled={!changed || update.isPending}>
          {update.isPending ? 'Guardando…' : 'Guardar'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Reintentos de cobro automático de las facturas vencidas (smart retry). */
export function AutoChargeRetryCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();
  const [max, setMax] = useState(3);
  const [interval, setInterval] = useState(3);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (settings.data && !ready) {
      setMax(settings.data.autoChargeRetryMax);
      setInterval(settings.data.autoChargeRetryIntervalDays);
      setReady(true);
    }
  }, [settings.data, ready]);

  if (!canConfigure) return null;
  if (settings.isLoading || !settings.data) return null;

  const enabled = settings.data.autoChargeRetryEnabled;
  const autoCharge = settings.data.autoChargeOnIssue;

  async function save(next: {
    autoChargeRetryEnabled?: boolean;
    autoChargeRetryMax?: number;
    autoChargeRetryIntervalDays?: number;
  }) {
    try {
      await update.mutateAsync(next);
      toast.success('Reintentos de cobro actualizados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Reintentos de cobro</CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>
            {enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Reintenta cobrar automáticamente las facturas vencidas (con un intervalo entre intentos)
          antes de escalar al proceso de impago. Recupera cobros que fallaron por un rechazo puntual
          de la tarjeta o la domiciliación.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!autoCharge && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Requiere el «Cobro automático» activado.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Nº máximo de reintentos</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={max}
              onChange={(e) => setMax(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
          <div className="space-y-1">
            <Label>Días entre reintentos</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={interval}
              onChange={(e) => setInterval(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => save({ autoChargeRetryEnabled: !enabled })}
            variant={enabled ? 'destructive' : 'default'}
            disabled={update.isPending || (!autoCharge && !enabled)}
          >
            {enabled ? 'Desactivar' : 'Activar reintentos'}
          </Button>
          <Button
            variant="outline"
            onClick={() => save({ autoChargeRetryMax: max, autoChargeRetryIntervalDays: interval })}
            disabled={update.isPending}
          >
            Guardar ajustes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Emisión automática de las facturas recurrentes (sin revisión manual). */
export function SepaSettingsCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useSepaSettings(canConfigure);
  const update = useUpdateSepaSettings();

  const [creditorName, setCreditorName] = useState('');
  const [creditorId, setCreditorId] = useState('');
  const [creditorIban, setCreditorIban] = useState('');
  const [creditorBic, setCreditorBic] = useState('');
  const [prenoticeDays, setPrenoticeDays] = useState(14);
  const [loaded, setLoaded] = useState(false);

  if (!canConfigure || settings.isLoading || !settings.data) return null;
  const s = settings.data;
  if (!loaded && s.configured) {
    setCreditorName(s.creditorName);
    setCreditorId(s.creditorId);
    setCreditorBic(s.creditorBic ?? '');
    setPrenoticeDays(s.prenoticeDays);
    setLoaded(true);
  }

  async function save(enabled: boolean) {
    if (!creditorName.trim() || !creditorId.trim()) {
      toast.error('Indica el nombre y el identificador del acreedor.');
      return;
    }
    if (!s.configured && !creditorIban.trim()) {
      toast.error('Indica el IBAN del acreedor.');
      return;
    }
    try {
      await update.mutateAsync({
        creditorName,
        creditorId,
        // El IBAN solo se envía si se reescribe; si no, el backend conserva el actual.
        ...(creditorIban.trim() ? { creditorIban: creditorIban.trim() } : {}),
        creditorBic,
        prenoticeDays,
        enabled,
      });
      toast.success('Ajustes SEPA guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'IBAN no válido.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Remesas SEPA (acreedor)</CardTitle>
          <Badge variant={s.enabled ? 'default' : 'outline'}>
            {s.enabled ? 'Activado' : 'Desactivado'}
          </Badge>
        </div>
        <CardDescription>
          Datos del acreedor para generar el fichero de adeudos SEPA (pain.008) que subes a tu
          banco. El IBAN se guarda cifrado.
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
              placeholder="Trasteros SL"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Identificador del acreedor</label>
            <Input
              value={creditorId}
              onChange={(e) => setCreditorId(e.target.value)}
              placeholder="ES12ZZZB12345678"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              IBAN del acreedor {s.configured && '(reescribir para cambiar)'}
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
              placeholder="CAIXESBBXXX"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="sepa-prenotice">
              Preaviso de los cargos (días)
            </label>
            <Input
              id="sepa-prenotice"
              type="number"
              min={1}
              max={30}
              value={prenoticeDays}
              onChange={(e) =>
                setPrenoticeDays(Math.min(30, Math.max(1, Number(e.target.value) || 14)))
              }
            />
            <p className="text-xs text-muted-foreground">
              La normativa SEPA exige 14 días salvo que tus contratos pacten otro plazo. Al generar
              una remesa te avisamos si la fecha de cargo no lo respeta.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => save(s.enabled)} disabled={update.isPending}>
            Guardar
          </Button>
          <Button
            variant={s.enabled ? 'destructive' : 'outline'}
            onClick={() => save(!s.enabled)}
            disabled={update.isPending}
          >
            {s.enabled ? 'Desactivar' : 'Activar remesas SEPA'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
