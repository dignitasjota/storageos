'use client';

import {
  CONTACT_PROFILE_OPTIONS,
  CONTACT_UNITS_OPTIONS,
  type PublicContactFormDto,
} from '@storageos/shared';
import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Formulario de contacto de la portada; los campos los decide el panel admin. */
export function PlatformContactForm({ config }: { config: PublicContactFormDto }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    units: '',
    profile: '',
    message: '',
    acceptPrivacy: false,
    hp: '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.acceptPrivacy) {
      setError('Acepta la política de privacidad para enviar el mensaje.');
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch(`${API_URL}/v1/platform-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          message: form.message.trim(),
          acceptPrivacy: true,
          hp: form.hp,
          ...(config.showPhone && form.phone.trim() ? { phone: form.phone.trim() } : {}),
          ...(config.showCompany && form.company.trim() ? { company: form.company.trim() } : {}),
          ...(config.showUnits && form.units ? { units: form.units } : {}),
          ...(config.showProfile && form.profile ? { profile: form.profile } : {}),
        }),
      });
      if (res.ok) {
        setStatus('sent');
        return;
      }
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      setError(
        res.status === 429
          ? 'Has enviado varios mensajes seguidos. Prueba de nuevo en un rato.'
          : body?.code === 'phone_required'
            ? 'Indica tu teléfono.'
            : 'Revisa los datos: el mensaje debe tener al menos 10 caracteres.',
      );
    } catch {
      setError('No se pudo enviar. Comprueba tu conexión o escríbenos a info@trasteros.pro.');
    }
    setStatus('idle');
  }

  if (status === 'sent') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card p-10 text-center">
        <CheckCircle2 className="size-10 text-emerald-600" aria-hidden />
        <p className="text-lg font-semibold">¡Mensaje enviado!</p>
        <p className="text-sm text-muted-foreground">
          Gracias, {form.name.split(' ')[0]}. Te responderemos a {form.email} lo antes posible.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4 rounded-2xl border bg-card p-6">
      {/* Campo trampa para bots: oculto a las personas. */}
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
          <Label htmlFor="pc-name">Nombre *</Label>
          <Input
            id="pc-name"
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pc-email">Email *</Label>
          <Input
            id="pc-email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </div>
        {config.showPhone && (
          <div className="space-y-1">
            <Label htmlFor="pc-phone">Teléfono{config.requirePhone ? ' *' : ''}</Label>
            <Input
              id="pc-phone"
              type="tel"
              required={config.requirePhone}
              maxLength={40}
              autoComplete="tel"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </div>
        )}
        {config.showCompany && (
          <div className="space-y-1">
            <Label htmlFor="pc-company">Empresa</Label>
            <Input
              id="pc-company"
              maxLength={160}
              autoComplete="organization"
              value={form.company}
              onChange={(e) => set('company', e.target.value)}
            />
          </div>
        )}
        {config.showUnits && (
          <div className="space-y-1">
            <Label htmlFor="pc-units">¿Cuántos trasteros o viviendas gestionas?</Label>
            <select
              id="pc-units"
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
        )}
        {config.showProfile && (
          <div className="space-y-1">
            <Label htmlFor="pc-profile">¿Qué describe mejor tu caso?</Label>
            <select
              id="pc-profile"
              className={SELECT_CLASS}
              value={form.profile}
              onChange={(e) => set('profile', e.target.value)}
            >
              <option value="">Elige una opción</option>
              {CONTACT_PROFILE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="pc-message">Mensaje *</Label>
        <Textarea
          id="pc-message"
          required
          minLength={10}
          maxLength={4000}
          rows={5}
          className="text-base sm:text-sm"
          value={form.message}
          onChange={(e) => set('message', e.target.value)}
        />
      </div>
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.acceptPrivacy}
          onChange={(e) => set('acceptPrivacy', e.target.checked)}
        />
        <span>
          He leído y acepto la{' '}
          <Link href="/privacidad" className="text-primary underline" target="_blank">
            política de privacidad
          </Link>
          . Usaremos tus datos solo para responderte.
        </span>
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={status === 'sending'}>
        {status === 'sending' && <Loader2 className="mr-2 size-4 animate-spin" />}
        Enviar mensaje
      </Button>
    </form>
  );
}
