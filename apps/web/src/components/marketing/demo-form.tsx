'use client';

import { CONTACT_UNITS_OPTIONS } from '@storageos/shared';
import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { platformTrafficFields } from '@/components/public/platform-attribution';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trackConversion } from '@/lib/marketing/track';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Pedir una demo: formulario corto que entra en Leads del panel admin con el
 * origen «Petición de demo» y el de la visita.
 */
export function DemoForm({ place }: { place: string }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    units: '',
    acceptPrivacy: false,
    hp: '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const id = (field: string) => `demo-${place}-${field}`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.acceptPrivacy) {
      setError('Acepta la política de privacidad para enviar la petición.');
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch(`${API_URL}/v1/platform-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'demo',
          name: form.name.trim(),
          email: form.email.trim(),
          acceptPrivacy: true,
          hp: form.hp,
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          ...(form.company.trim() ? { company: form.company.trim() } : {}),
          ...(form.units ? { units: form.units } : {}),
          ...platformTrafficFields(),
        }),
      });
      if (res.ok) {
        trackConversion('generate_lead', { form: 'demo', place });
        setStatus('sent');
        return;
      }
      setError(
        res.status === 429
          ? 'Has enviado varias peticiones seguidas. Prueba de nuevo en un rato.'
          : 'Revisa tu nombre y tu email.',
      );
    } catch {
      setError('No se pudo enviar. Comprueba tu conexión o escríbenos a info@trasteros.pro.');
    }
    setStatus('idle');
  }

  if (status === 'sent') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card p-8 text-center">
        <CheckCircle2 className="size-10 text-emerald-600" aria-hidden />
        <p className="text-lg font-semibold">¡Petición enviada!</p>
        <p className="text-sm text-muted-foreground">
          Gracias, {form.name.split(' ')[0]}. Te escribimos a {form.email} para buscar un hueco.
          Mientras, puedes{' '}
          <Link href="/register" className="font-medium text-primary underline">
            crear tu cuenta gratis
          </Link>{' '}
          y verlo por dentro.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="space-y-4 rounded-2xl border bg-card p-6 text-left shadow-sm"
    >
      <div className="hidden" aria-hidden>
        <label>
          No rellenar
          <input
            tabIndex={-1}
            autoComplete="off"
            value={form.hp}
            onChange={(e) => set('hp', e.target.value)}
          />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={id('name')}>Nombre *</Label>
          <Input
            id={id('name')}
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id('email')}>Email *</Label>
          <Input
            id={id('email')}
            type="email"
            required
            maxLength={200}
            autoComplete="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id('phone')}>Teléfono</Label>
          <Input
            id={id('phone')}
            type="tel"
            maxLength={30}
            autoComplete="tel"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id('units')}>¿Cuántos trasteros gestionas?</Label>
          <select
            id={id('units')}
            className={SELECT_CLASS}
            value={form.units}
            onChange={(e) => set('units', e.target.value)}
          >
            <option value="">Elige una opción</option>
            {CONTACT_UNITS_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={id('company')}>Empresa</Label>
          <Input
            id={id('company')}
            maxLength={160}
            autoComplete="organization"
            value={form.company}
            onChange={(e) => set('company', e.target.value)}
          />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="mt-1"
          checked={form.acceptPrivacy}
          onChange={(e) => set('acceptPrivacy', e.target.checked)}
        />
        <span>
          He leído y acepto la{' '}
          <Link href="/privacidad" className="underline" target="_blank">
            política de privacidad
          </Link>
          . Usaremos tus datos solo para organizar la demo.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={status === 'sending'}>
        {status === 'sending' && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
        Pedir una demo
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Te enseñamos el programa con tus casos, sin compromiso.
      </p>
    </form>
  );
}
