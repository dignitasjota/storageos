'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { FeatureGate } from '@/components/auth/feature-gate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAccessSettings, useUpdateAccessSettings } from '@/lib/access/settings-hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';

/** Lo que el inquilino puede hacer con sus accesos desde su área de clientes. */
export default function AccessSettingsPage() {
  return (
    <FeatureGate feature="access_control">
      <div className="space-y-4">
        <ExtraAccessSettingsCard />
        <NightPassSettingsCard />
        <CutPolicyCard />
        <AlertsCard />
      </div>
    </FeatureGate>
  );
}

/**
 * Ajuste del tenant: máximo de accesos adicionales que un inquilino puede
 * crearse desde su portal (p. ej. para familiares). Solo owner/manager.
 */
function ExtraAccessSettingsCard() {
  const canManage = useHasPermission('settings:manage');
  const settings = useAccessSettings();
  const update = useUpdateAccessSettings();
  const [value, setValue] = useState<string>('');

  if (!canManage) return null;

  const current = settings.data?.extraAccessLimit ?? 0;
  const parsed = value === '' ? current : Number(value);
  const dirty = value !== '' && Number(value) !== current;

  async function save() {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      toast.error('Indica un número entre 0 y 10.');
      return;
    }
    try {
      await update.mutateAsync({ extraAccessLimit: n });
      setValue('');
      toast.success('Límite de accesos actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Accesos adicionales del inquilino</CardTitle>
        <CardDescription>
          Cuántos accesos extra (para familiares, empleados…) puede crearse cada inquilino desde su
          portal, además del que recibe al contratar. 0 = desactivado.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="extra-access-limit" className="text-xs">
              Máximo por inquilino
            </Label>
            <Input
              id="extra-access-limit"
              type="number"
              min={0}
              max={10}
              className="h-9 w-24"
              value={value === '' ? String(current) : value}
              onChange={(e) => setValue(e.target.value)}
              disabled={settings.isLoading}
            />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
            Guardar
          </Button>
          <span className="pb-2 text-xs text-muted-foreground">Actual: {parsed}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Pase nocturno: el inquilino compra un código de un solo uso (de pago). */
function NightPassSettingsCard() {
  const canManage = useHasPermission('settings:manage');
  const settings = useAccessSettings();
  const update = useUpdateAccessSettings();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [price, setPrice] = useState<string>('');

  if (!canManage) return null;

  const curEnabled = enabled ?? settings.data?.nightPassEnabled ?? false;
  const curPrice = price === '' ? (settings.data?.nightPassPrice ?? 0) : Number(price);

  async function save() {
    try {
      await update.mutateAsync({ nightPassEnabled: curEnabled, nightPassPrice: curPrice });
      setEnabled(null);
      setPrice('');
      toast.success('Pase nocturno actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pase nocturno (de pago)</CardTitle>
        <CardDescription>
          Permite al inquilino comprar desde su portal un código de <strong>un solo uso</strong> que
          salta el toque de queda y caduca a la mañana siguiente. Se le factura el importe (+ IVA).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={curEnabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4"
            />
            Activar
          </label>
          <div className="space-y-1">
            <Label htmlFor="night-pass-price" className="text-xs">
              Precio (€, sin IVA)
            </Label>
            <Input
              id="night-pass-price"
              type="number"
              step="0.01"
              min={0}
              className="h-9 w-28"
              value={price === '' ? String(settings.data?.nightPassPrice ?? 0) : price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={settings.isLoading}
            />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={update.isPending}>
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Qué corta el impago y a los cuántos días. */
function CutPolicyCard() {
  const settings = useAccessSettings();
  const update = useUpdateAccessSettings();
  const [mode, setMode] = useState<'all' | 'extras' | 'none' | null>(null);
  const [days, setDays] = useState('');

  const curMode = mode ?? settings.data?.accessCutMode ?? 'all';
  const curDays = days === '' ? (settings.data?.accessCutDays ?? 14) : Number(days);

  async function save() {
    if (!Number.isInteger(curDays) || curDays < 1 || curDays > 90) {
      toast.error('Indica entre 1 y 90 días.');
      return;
    }
    try {
      await update.mutateAsync({ accessCutMode: curMode, accessCutDays: curDays });
      setMode(null);
      setDays('');
      toast.success('Política de corte guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Corte del acceso por impago</CardTitle>
        <CardDescription>
          Se aplica a las facturas que venzan a partir de ahora. Al pagar, el acceso vuelve solo.
          Todo el calendario de impagos, en{' '}
          <Link href="/settings/dunning" className="font-medium underline-offset-2 hover:underline">
            Escalado de impagos
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Qué se corta</Label>
            <Select value={curMode} onValueChange={(v) => setMode(v as typeof curMode)}>
              <SelectTrigger className="h-9 w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos sus accesos</SelectItem>
                <SelectItem value="extras">Solo adicionales, visitas y pases</SelectItem>
                <SelectItem value="none">Nada: no cortar nunca</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {curMode !== 'none' && (
            <div className="space-y-1">
              <Label htmlFor="cut-days" className="text-xs">
                Días tras el vencimiento
              </Label>
              <Input
                id="cut-days"
                type="number"
                min={1}
                max={90}
                className="h-9 w-24"
                value={days === '' ? String(curDays) : days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          )}
          <Button size="sm" onClick={() => void save()} disabled={update.isPending}>
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const ALERTS = [
  { key: 'cutAttempt', label: 'Un inquilino con el acceso cortado intenta entrar' },
  { key: 'repeatedFailures', label: 'Una puerta se bloquea por PIN erróneos repetidos' },
  { key: 'nightAttempt', label: 'Alguien intenta entrar fuera de horario' },
  { key: 'deviceOffline', label: 'Una puerta se queda sin conexión' },
] as const;

/** Qué avisa al equipo en la campana y en el móvil. */
function AlertsCard() {
  const settings = useAccessSettings();
  const update = useUpdateAccessSettings();

  async function toggle(key: (typeof ALERTS)[number]['key'], value: boolean) {
    try {
      await update.mutateAsync({ accessAlerts: { [key]: value } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Avisos de seguridad</CardTitle>
        <CardDescription>Llegan a la campana y al móvil de quien vea ese local.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {ALERTS.map((a) => (
          <label key={a.key} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={settings.data?.accessAlerts[a.key] ?? true}
              disabled={settings.isLoading || update.isPending}
              onCheckedChange={(v) => void toggle(a.key, v === true)}
            />
            {a.label}
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
