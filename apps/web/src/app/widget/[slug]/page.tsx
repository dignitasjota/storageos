'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { WidgetLeadSchema, type WidgetFacilityDto, type WidgetLeadInput } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { use, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { env } from '@/lib/env';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default function WidgetPage({ params }: PageProps) {
  const { slug } = use(params);
  const [facilities, setFacilities] = useState<WidgetFacilityDto[] | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Tracking de campañas: captura los utm_* de la URL al cargar (origen de captación).
  const [utm, setUtm] = useState<{
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
  }>({});

  const form = useForm<WidgetLeadInput>({
    resolver: zodResolver(WidgetLeadSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      message: '',
      hp: '',
      acceptsTerms: false,
      acceptsMarketing: false,
    },
  });

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pick = (k: string) => q.get(k)?.slice(0, 120) || undefined;
    setUtm({
      utmSource: pick('utm_source'),
      utmMedium: pick('utm_medium'),
      utmCampaign: pick('utm_campaign'),
    });
  }, []);

  useEffect(() => {
    fetch(`${env.apiUrl}/public/widget/${slug}/facilities`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: WidgetFacilityDto[]) => setFacilities(data))
      .catch(() => setFacilities([]));
  }, [slug]);

  const onSubmit = async (input: WidgetLeadInput) => {
    setSubmitError(null);
    try {
      const res = await fetch(`${env.apiUrl}/public/widget/${slug}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, ...utm }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'No se pudo enviar');
    }
  };

  if (facilities === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (submitted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>¡Gracias!</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Hemos recibido tu solicitud. Te contactaremos en breve.</p>
        </CardContent>
      </Card>
    );
  }

  // Tipos con disponibilidad (el backend ya los trae con precio y plazas).
  const availableTypes = facilities
    .flatMap((f) => f.unitTypes.map((t) => ({ ...t, facilityName: f.name })))
    .filter((t) => t.availableUnits > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trasteros disponibles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {availableTypes.length > 0 && (
          <div className="space-y-2">
            <ul className="space-y-2">
              {availableTypes.map((t) => (
                <li
                  key={`${t.facilityName}-${t.id}`}
                  className="flex items-start justify-between gap-3 rounded-md border p-2.5 text-sm"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium">
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                        aria-hidden
                      />
                      {t.name}
                    </span>
                    {t.description && (
                      <span className="block text-xs text-muted-foreground">{t.description}</span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {t.facilityName} · {t.availableUnits} disponible
                      {t.availableUnits === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right font-semibold tabular-nums">
                    {(t.defaultPriceMonthly * 1.21).toLocaleString('es-ES', {
                      style: 'currency',
                      currency: 'EUR',
                      maximumFractionDigits: 0,
                    })}
                    <span className="block text-xs font-normal text-muted-foreground">
                      /mes · IVA incl.
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <Button asChild className="w-full">
              <a href={`/book/${slug}`} target="_blank" rel="noopener noreferrer">
                Reservar online
              </a>
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              o déjanos tus datos y te llamamos:
            </p>
          </div>
        )}
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
          <div>
            <Label htmlFor="firstName">Nombre*</Label>
            <Input id="firstName" {...form.register('firstName')} />
          </div>
          <div>
            <Label htmlFor="lastName">Apellidos</Label>
            <Input id="lastName" {...form.register('lastName')} />
          </div>
          <div>
            <Label htmlFor="email">Email*</Label>
            <Input id="email" type="email" {...form.register('email')} />
          </div>
          <div>
            <Label htmlFor="phone">Teléfono*</Label>
            <Input id="phone" {...form.register('phone')} />
          </div>
          {facilities.length > 0 && (
            <div>
              <Label htmlFor="preferredFacility">Local preferido</Label>
              <Select
                onValueChange={(v) =>
                  form.setValue('preferredFacilityId', v === 'any' ? undefined : v)
                }
                defaultValue="any"
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Cualquiera</SelectItem>
                  {facilities.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name} {f.city ? `— ${f.city}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="message">Mensaje</Label>
            <Input id="message" {...form.register('message')} />
          </div>
          {/* Honeypot oculto: si lo rellenan, es bot. */}
          <input
            type="text"
            {...form.register('hp')}
            tabIndex={-1}
            autoComplete="off"
            style={{ position: 'absolute', left: '-9999px', height: 0, width: 0 }}
            aria-hidden="true"
          />
          <div className="flex items-start gap-2">
            <Checkbox
              id="acceptsTerms"
              checked={form.watch('acceptsTerms')}
              onCheckedChange={(v) => form.setValue('acceptsTerms', Boolean(v))}
            />
            <Label htmlFor="acceptsTerms" className="text-xs">
              He leído y acepto la política de privacidad y el tratamiento de mis datos.*
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="acceptsMarketing"
              onCheckedChange={(v) => form.setValue('acceptsMarketing', Boolean(v))}
            />
            <Label htmlFor="acceptsMarketing" className="text-xs">
              Acepto recibir novedades por email
            </Label>
          </div>
          {submitError && <p className="text-sm text-destructive">{submitError}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={form.formState.isSubmitting || !form.watch('acceptsTerms')}
          >
            {form.formState.isSubmitting ? 'Enviando...' : 'Enviar solicitud'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
