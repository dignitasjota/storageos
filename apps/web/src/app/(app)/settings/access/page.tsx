'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { TenantAccessSettingsResponse } from '@storageos/shared';

import { FeatureGate } from '@/components/auth/feature-gate';
import { SectionError } from '@/components/dashboard/section-state';
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
  const settings = useAccessSettings();
  const canManage = useHasPermission('settings:manage');

  return (
    <FeatureGate feature="access_control">
      <div className="space-y-4">
        {settings.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : settings.isError || !settings.data ? (
          // Sin los ajustes actuales no se enseña nada que se pueda guardar: se
          // grabarían ceros y casillas apagadas encima de lo que hay.
          <Card>
            <CardContent>
              <SectionError onRetry={() => void settings.refetch()} />
            </CardContent>
          </Card>
        ) : (
          <>
            <ExtraAccessSettingsCard data={settings.data} canManage={canManage} />
            <NightPassSettingsCard data={settings.data} canManage={canManage} />
            <CutPolicyCard data={settings.data} canManage={canManage} />
            <AlertsCard data={settings.data} canManage={canManage} />
          </>
        )}
      </div>
    </FeatureGate>
  );
}

interface CardProps {
  data: TenantAccessSettingsResponse;
  canManage: boolean;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo guardar.';
}

/**
 * Máximo de accesos adicionales que un inquilino puede crearse desde su portal
 * (p. ej. para familiares).
 */
function ExtraAccessSettingsCard({ data, canManage }: CardProps) {
  const update = useUpdateAccessSettings();
  // `null` = sin tocar (se ve lo guardado); el campo se puede vaciar al escribir.
  const [value, setValue] = useState<string | null>(null);

  const current = data.extraAccessLimit;
  const shown = value ?? String(current);
  const dirty = value !== null && value.trim() !== String(current);

  async function save() {
    const n = Number(shown.trim());
    if (shown.trim() === '' || !Number.isInteger(n) || n < 0 || n > 10) {
      toast.error('Indica un número entero entre 0 y 10.');
      return;
    }
    try {
      await update.mutateAsync({ extraAccessLimit: n });
      setValue(null);
      toast.success('Límite de accesos actualizado.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Accesos adicionales del inquilino</CardTitle>
        <CardDescription>
          Cuántos accesos extra (para familiares, empleados…) puede crearse cada inquilino desde su
          área de clientes, además del que recibe al contratar. 0 = no puede crearse ninguno.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="extra-access-limit" className="text-xs">
              Máximo por inquilino
            </Label>
            <Input
              id="extra-access-limit"
              type="number"
              inputMode="numeric"
              min={0}
              max={10}
              className="h-9 w-24"
              value={shown}
              onChange={(e) => setValue(e.target.value)}
              disabled={!canManage}
            />
          </div>
          {canManage && (
            <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
              Guardar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Pase nocturno: el inquilino compra un código de un solo uso (de pago). */
function NightPassSettingsCard({ data, canManage }: CardProps) {
  const update = useUpdateAccessSettings();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [price, setPrice] = useState<string | null>(null);

  const curEnabled = enabled ?? data.nightPassEnabled;
  const shownPrice = price ?? String(data.nightPassPrice);
  const dirty = enabled !== null || price !== null;

  async function save() {
    const n = Number(shownPrice.trim().replace(',', '.'));
    if (shownPrice.trim() === '' || !Number.isFinite(n) || n < 0) {
      toast.error('Indica un precio válido (0 o más).');
      return;
    }
    try {
      await update.mutateAsync({ nightPassEnabled: curEnabled, nightPassPrice: n });
      setEnabled(null);
      setPrice(null);
      toast.success('Pase nocturno actualizado.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pase nocturno (de pago)</CardTitle>
        <CardDescription>
          Permite al inquilino comprar desde su área de clientes un código de{' '}
          <strong>un solo uso</strong> que salta el toque de queda y caduca a la mañana siguiente.
          Se le factura el importe (+ IVA).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={curEnabled}
              disabled={!canManage}
              onCheckedChange={(v) => setEnabled(v === true)}
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
              inputMode="decimal"
              step="0.01"
              min={0}
              className="h-9 w-28"
              value={shownPrice}
              onChange={(e) => setPrice(e.target.value)}
              disabled={!canManage}
            />
          </div>
          {canManage && (
            <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
              Guardar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Qué corta el impago y a los cuántos días. */
function CutPolicyCard({ data, canManage }: CardProps) {
  const update = useUpdateAccessSettings();
  const [mode, setMode] = useState<'all' | 'extras' | 'none' | null>(null);
  const [days, setDays] = useState<string | null>(null);

  const curMode = mode ?? data.accessCutMode;
  const shownDays = days ?? String(data.accessCutDays);
  const dirty = mode !== null || days !== null;

  async function save() {
    const n = Number(shownDays.trim());
    if (
      curMode !== 'none' &&
      (shownDays.trim() === '' || !Number.isInteger(n) || n < 1 || n > 90)
    ) {
      toast.error('Indica entre 1 y 90 días.');
      return;
    }
    try {
      await update.mutateAsync({
        accessCutMode: curMode,
        ...(curMode !== 'none' ? { accessCutDays: n } : {}),
      });
      setMode(null);
      setDays(null);
      toast.success('Política de corte guardada.');
    } catch (err) {
      toast.error(errorText(err));
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
            <Select
              value={curMode}
              onValueChange={(v) => setMode(v as typeof curMode)}
              disabled={!canManage}
            >
              <SelectTrigger className="h-9 w-64 max-w-full">
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
                inputMode="numeric"
                min={1}
                max={90}
                className="h-9 w-24"
                value={shownDays}
                onChange={(e) => setDays(e.target.value)}
                disabled={!canManage}
              />
            </div>
          )}
          {canManage && (
            <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
              Guardar
            </Button>
          )}
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
function AlertsCard({ data, canManage }: CardProps) {
  const update = useUpdateAccessSettings();

  async function toggle(key: (typeof ALERTS)[number]['key'], value: boolean) {
    try {
      await update.mutateAsync({ accessAlerts: { [key]: value } });
    } catch (err) {
      toast.error(errorText(err));
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
              checked={data.accessAlerts[a.key] ?? true}
              disabled={!canManage || update.isPending}
              onCheckedChange={(v) => void toggle(a.key, v === true)}
            />
            {a.label}
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
