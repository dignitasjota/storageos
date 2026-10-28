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

/**
 * Formas de pago sin pasarela que el inquilino puede elegir al reservar o
 * pagar una factura. Si no se activan aquí, no aparecen.
 */
export function OfflinePaymentOptionsCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useTenantBillingSettings(canConfigure);
  const sepa = useSepaSettings(canConfigure);
  const update = useUpdateTenantBillingSettings();

  if (!canConfigure || !settings.data) return null;
  const s = settings.data;
  const sepaReady = !!sepa.data?.enabled && !!sepa.data.creditorAddress;

  async function toggle(
    key: 'offlineTransferEnabled' | 'offlineCashEnabled' | 'offlineSepaEnabled',
    value: boolean,
  ) {
    try {
      await update.mutateAsync({ [key]: value });
      toast.success(value ? 'Forma de pago activada.' : 'Forma de pago desactivada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar');
    }
  }

  const rows: {
    key: 'offlineTransferEnabled' | 'offlineCashEnabled' | 'offlineSepaEnabled';
    title: string;
    text: string;
    enabled: boolean;
    blocked: string | null;
  }[] = [
    {
      key: 'offlineTransferEnabled',
      title: 'Transferencia',
      text: 'Le llega por correo el IBAN, el importe y el concepto.',
      enabled: s.offlineTransferEnabled,
      blocked: s.transferIban ? null : 'Guarda antes el IBAN para transferencias.',
    },
    {
      key: 'offlineCashEnabled',
      title: 'Pagar en el local',
      text: 'Paga en persona (efectivo o lo que aceptes en el local).',
      enabled: s.offlineCashEnabled,
      blocked: null,
    },
    {
      key: 'offlineSepaEnabled',
      title: 'Domiciliación SEPA',
      text: 'Pone su IBAN y firma el mandato; se le cobra en tu próxima remesa SEPA.',
      enabled: s.offlineSepaEnabled,
      blocked: sepaReady
        ? null
        : 'Activa antes las remesas SEPA (más abajo) con el domicilio del acreedor.',
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Otras formas de pago para el inquilino</CardTitle>
        <CardDescription>
          Lo que puede elegir al reservar online o al pagar una factura desde su área de clientes,
          además de la tarjeta o Bizum. Con transferencia o pago en el local, la reserva se guarda
          24 horas más y te avisamos para que estés atento; cuando cobres, marca la factura como
          pagada indicando cómo.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start justify-between gap-4 py-3 first:pt-0">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{r.title}</p>
              <p className="text-sm text-muted-foreground">{r.text}</p>
              {r.blocked && !r.enabled && (
                <p className="text-xs text-amber-700 dark:text-amber-400">{r.blocked}</p>
              )}
            </div>
            <Button
              size="sm"
              variant={r.enabled ? 'outline' : 'default'}
              disabled={update.isPending || (!r.enabled && !!r.blocked)}
              onClick={() => void toggle(r.key, !r.enabled)}
            >
              {r.enabled ? 'Desactivar' : 'Activar'}
            </Button>
          </div>
        ))}
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

/** Datos del acreedor de las remesas SEPA (fichero de adeudos para tu banco). */
export function SepaSettingsCard() {
  const canConfigure = useHasPermission('billing:configure');
  const settings = useSepaSettings(canConfigure);
  const update = useUpdateSepaSettings();

  const [creditorName, setCreditorName] = useState('');
  const [creditorId, setCreditorId] = useState('');
  const [creditorIban, setCreditorIban] = useState('');
  const [creditorBic, setCreditorBic] = useState('');
  const [prenoticeDays, setPrenoticeDays] = useState('14');
  const [creditorAddress, setCreditorAddress] = useState('');
  const [creditorPostalCode, setCreditorPostalCode] = useState('');
  const [creditorCity, setCreditorCity] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Se rellena una vez al cargar (no en el render, y sin pisar lo que se escribe).
  useEffect(() => {
    const s = settings.data;
    if (!s || loaded) return;
    if (s.configured) {
      setCreditorName(s.creditorName);
      setCreditorId(s.creditorId);
      setCreditorBic(s.creditorBic ?? '');
      setPrenoticeDays(String(s.prenoticeDays));
      setCreditorAddress(s.creditorAddress ?? '');
      setCreditorPostalCode(s.creditorPostalCode ?? '');
      setCreditorCity(s.creditorCity ?? '');
    }
    setLoaded(true);
  }, [settings.data, loaded]);

  if (!canConfigure || settings.isLoading || !settings.data) return null;
  const s = settings.data;
  const prenotice = Number(prenoticeDays);
  const prenoticeValid = Number.isInteger(prenotice) && prenotice >= 1 && prenotice <= 30;

  async function save(enabled: boolean) {
    if (!creditorName.trim() || !creditorId.trim()) {
      toast.error('Indica el nombre y el identificador del acreedor.');
      return;
    }
    if (!prenoticeValid) {
      toast.error('El preaviso debe ser de 1 a 30 días.');
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
        prenoticeDays: prenotice,
        enabled,
        creditorAddress: creditorAddress.trim(),
        creditorPostalCode: creditorPostalCode.trim(),
        creditorCity: creditorCity.trim(),
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
              placeholder="ES97ZZZB12345678"
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
              Sale en la orden de domiciliación que firman tus inquilinos (lo exige el banco).
            </p>
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
              onChange={(e) => setPrenoticeDays(e.target.value)}
              aria-invalid={!prenoticeValid}
            />
            {!prenoticeValid && <p className="text-xs text-destructive">De 1 a 30 días.</p>}
            <p className="text-xs text-muted-foreground">
              La normativa SEPA exige 14 días salvo que se pacte otro plazo: el que pongas aquí
              figura en la orden de domiciliación que firma el inquilino. Al generar una remesa te
              avisamos si la fecha de cargo no lo respeta.
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
