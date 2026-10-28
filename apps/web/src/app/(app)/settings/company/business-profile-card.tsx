'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useTenantProfile, useUpdateTenantProfile } from '@/lib/tenant-settings/hooks';

/** Las zonas habituales, primero; después todas las que conoce el navegador. */
const COMMON_ZONES = [
  'Europe/Madrid',
  'Atlantic/Canary',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Paris',
  'Europe/Andorra',
];

function allZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const list = intl.supportedValuesOf?.('timeZone') ?? [];
    return list.filter((z) => !COMMON_ZONES.includes(z));
  } catch {
    return [];
  }
}

function zoneLabel(zone: string): string {
  if (zone === 'Europe/Madrid') return 'España peninsular y Baleares (Europe/Madrid)';
  if (zone === 'Atlantic/Canary') return 'Canarias (Atlantic/Canary)';
  return zone;
}

/** Nombre comercial y zona horaria del negocio. */
export function BusinessProfileCard() {
  const canManage = useHasPermission('settings:manage');
  const profile = useTenantProfile();
  const update = useUpdateTenantProfile();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Europe/Madrid');
  const others = useMemo(allZones, []);

  useEffect(() => {
    if (profile.data) {
      setName(profile.data.name);
      setTimezone(profile.data.timezone);
    }
  }, [profile.data]);

  if (!profile.data) {
    return (
      <Card>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const dirty = name.trim() !== profile.data.name || timezone !== profile.data.timezone;
  const zones = [...COMMON_ZONES, ...others];
  if (!zones.includes(timezone)) zones.unshift(timezone);

  async function save() {
    try {
      await update.mutateAsync({ name: name.trim(), timezone });
      toast.success('Datos del negocio guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Tu negocio</CardTitle>
        <CardDescription>
          El nombre sale en tu web, en el área de clientes, en la app y en los correos a tus
          inquilinos. La zona horaria decide qué es «hoy»: los avisos, el resumen diario y la fecha
          de tus facturas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="biz-name">Nombre comercial</Label>
            <Input
              id="biz-name"
              value={name}
              maxLength={120}
              disabled={!canManage}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="biz-tz">Zona horaria</Label>
            <select
              id="biz-tz"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-base sm:text-sm"
              value={timezone}
              disabled={!canManage}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {zoneLabel(z)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Identificador de tu empresa (para entrar y en tu dirección web):{' '}
          <code>{profile.data.slug}</code>. No se puede cambiar.
        </p>
        {canManage && (
          <div className="flex justify-end">
            <Button
              onClick={() => void save()}
              disabled={update.isPending || !dirty || name.trim().length < 2}
            >
              {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
