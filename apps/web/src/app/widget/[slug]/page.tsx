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
      acceptsTerms: true,
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reservar trastero</CardTitle>
      </CardHeader>
      <CardContent>
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
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Enviando...' : 'Enviar solicitud'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
