'use client';

import { type FacilityDto } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
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
import { ApiError } from '@/lib/auth/api';
import { useUpdateFacility } from '@/lib/facilities/hooks';

/** Zonas horarias habituales (España continental y Canarias, Portugal). */
const TIMEZONES = ['Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon'];

interface Form {
  name: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  timezone: string;
  contactPhone: string;
  contactEmail: string;
  latitude: string;
  longitude: string;
  isActive: boolean;
}

function fromFacility(f: FacilityDto): Form {
  return {
    name: f.name,
    address: f.address ?? '',
    city: f.city ?? '',
    postalCode: f.postalCode ?? '',
    country: f.country,
    timezone: f.timezone,
    contactPhone: f.contactPhone ?? '',
    contactEmail: f.contactEmail ?? '',
    latitude: f.latitude != null ? String(f.latitude) : '',
    longitude: f.longitude != null ? String(f.longitude) : '',
    isActive: f.isActive,
  };
}

/** Datos básicos del local: nombre, dirección, contacto, zona horaria, mapa y si está activo. */
export function FacilityDetailsCard({ facility }: { facility: FacilityDto }) {
  const ask = useConfirm();
  const update = useUpdateFacility();
  const [form, setForm] = useState<Form>(() => fromFacility(facility));
  // Se rellena al cambiar de local, no al refrescar (no pisa lo que se escribe).
  useEffect(() => setForm(fromFacility(facility)), [facility.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    const lat = form.latitude.trim() ? Number(form.latitude.replace(',', '.')) : undefined;
    const lng = form.longitude.trim() ? Number(form.longitude.replace(',', '.')) : undefined;
    if (
      (lat !== undefined && !Number.isFinite(lat)) ||
      (lng !== undefined && !Number.isFinite(lng))
    ) {
      toast.error('Las coordenadas tienen que ser números (p. ej. 40.4168 y -3.7038).');
      return;
    }
    if (form.name.trim().length < 2) {
      toast.error('El nombre necesita al menos 2 caracteres.');
      return;
    }
    if (
      facility.isActive &&
      !form.isActive &&
      !(await ask({
        title: '¿Desactivar el local?',
        description:
          'Deja de salir en tu web y en la reserva online. Sus contratos y su facturación siguen igual.',
      }))
    ) {
      return;
    }
    try {
      await update.mutateAsync({
        id: facility.id,
        input: {
          name: form.name.trim(),
          address: form.address.trim(),
          city: form.city.trim(),
          postalCode: form.postalCode.trim(),
          country: form.country.trim().toUpperCase(),
          timezone: form.timezone,
          contactPhone: form.contactPhone.trim(),
          contactEmail: form.contactEmail.trim(),
          ...(lat !== undefined ? { latitude: lat } : {}),
          ...(lng !== undefined ? { longitude: lng } : {}),
          isActive: form.isActive,
        },
      });
      toast.success('Datos del local guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const mapHref =
    form.latitude && form.longitude
      ? `https://www.google.com/maps?q=${encodeURIComponent(`${form.latitude},${form.longitude}`)}`
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Datos del local</CardTitle>
        <CardDescription>
          Salen en tu web, en los contratos y en los correos a los inquilinos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="fd-name" label="Nombre" value={form.name} onChange={(v) => set('name', v)} />
          <Field id="fd-city" label="Ciudad" value={form.city} onChange={(v) => set('city', v)} />
          <Field
            id="fd-address"
            label="Dirección"
            value={form.address}
            onChange={(v) => set('address', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              id="fd-cp"
              label="Código postal"
              value={form.postalCode}
              onChange={(v) => set('postalCode', v)}
            />
            <Field
              id="fd-country"
              label="País (2 letras)"
              value={form.country}
              onChange={(v) => set('country', v.slice(0, 2))}
            />
          </div>
          <Field
            id="fd-phone"
            label="Teléfono de contacto"
            value={form.contactPhone}
            onChange={(v) => set('contactPhone', v)}
          />
          <Field
            id="fd-email"
            label="Email de contacto"
            value={form.contactEmail}
            onChange={(v) => set('contactEmail', v)}
          />
          <div className="space-y-1">
            <Label>Zona horaria</Label>
            <Select value={form.timezone} onValueChange={(v) => set('timezone', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...TIMEZONES, facility.timezone])].map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              La del horario, el toque de queda y las fechas del local.
            </p>
          </div>
          <div className="space-y-1">
            <Label>Ubicación en el mapa</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label="Latitud"
                placeholder="Latitud (40.4168)"
                value={form.latitude}
                onChange={(e) => set('latitude', e.target.value)}
              />
              <Input
                aria-label="Longitud"
                placeholder="Longitud (-3.7038)"
                value={form.longitude}
                onChange={(e) => set('longitude', e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              En Google Maps, botón derecho sobre el local → copia los números.{' '}
              {mapHref && (
                <a href={mapHref} target="_blank" rel="noreferrer" className="underline">
                  Comprobar en el mapa
                </a>
              )}
            </p>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={form.isActive} onCheckedChange={(v) => set('isActive', v === true)} />
          <span>
            Local activo
            <span className="block text-xs text-muted-foreground">
              Desactivado no sale en tu web ni en la reserva online.
            </span>
          </span>
        </label>
        <Button onClick={() => void save()} disabled={update.isPending}>
          {update.isPending ? 'Guardando…' : 'Guardar'}
        </Button>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
