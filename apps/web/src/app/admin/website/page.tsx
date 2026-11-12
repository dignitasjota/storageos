'use client';

import {
  PLATFORM_LOGO_MAX_BYTES,
  type PlatformContactSettingsDto,
  type PlatformFounderOfferDto,
} from '@storageos/shared';
import { ExternalLink, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { FooterCard } from './footer-card';
import { HomeTextsCard } from './home-texts-card';
import { SeoCard } from './seo-card';

import { PlatformLogo } from '@/components/public/platform-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminContactSettings,
  useAdminFounderOffer,
  useAdminPlatformWebsite,
  useResetPlatformLogo,
  useUpdateContactSettings,
  useUpdateFounderOffer,
  useUploadPlatformLogo,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

/** Ajustes de la web pública de TrasterOS (no las webs de los tenants). */
export default function AdminWebsitePage() {
  const canEdit = useIsSuperadmin();
  const { data } = useAdminFounderOffer();
  const update = useUpdateFounderOffer();
  const [form, setForm] = useState<PlatformFounderOfferDto | null>(null);

  useEffect(() => {
    if (data && !form) setForm({ ...data });
  }, [data, form]);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync(form);
      toast.success(
        form.enabled
          ? 'Guardado. La web la mostrará en un minuto como mucho.'
          : 'Guardado. La oferta no se muestra en la web.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Web de TrasterOS</h1>
            <p className="text-sm text-muted-foreground">
              Lo que aparece en trasteros.pro (no afecta a las webs de los tenants).
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href={process.env.NEXT_PUBLIC_SITE_URL ?? '/'} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 size-4" />
              Ver la web
            </a>
          </Button>
        </div>
        {!canEdit && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            Con el rol de soporte puedes ver estos ajustes y atender los mensajes, pero no
            cambiarlos.
          </p>
        )}
      </div>

      <SeoCard />

      <HomeTextsCard />

      <LogoCard />

      <FooterCard />

      <ContactSettingsCard />

      <ContactMessagesCard />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Oferta fundador</CardTitle>
          <CardDescription>
            Recuadro que aparece encima de los planes, en la sección de precios.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!form ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                Mostrar la oferta en la web
              </label>
              <div className="space-y-1">
                <Label htmlFor="fo-title">Título</Label>
                <Input
                  id="fo-title"
                  value={form.title}
                  maxLength={80}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fo-text">Texto</Label>
                <Textarea
                  id="fo-text"
                  value={form.text}
                  maxLength={400}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
                <div className="space-y-1">
                  <Label htmlFor="fo-strike">Precio tachado</Label>
                  <Input
                    id="fo-strike"
                    value={form.setupStrike}
                    maxLength={30}
                    placeholder="490€"
                    onChange={(e) => setForm({ ...form, setupStrike: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fo-setup">Texto junto al precio tachado</Label>
                  <Input
                    id="fo-setup"
                    value={form.setupText}
                    maxLength={200}
                    onChange={(e) => setForm({ ...form, setupText: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Deja vacíos el precio tachado y su texto para quitar esa línea.
              </p>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Vista previa</p>
                <div
                  className={`rounded-2xl border border-primary/30 bg-primary/5 p-5 text-center ${form.enabled ? '' : 'opacity-50'}`}
                >
                  <p className="text-sm font-semibold text-primary">🚀 {form.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{form.text}</p>
                  {(form.setupStrike || form.setupText) && (
                    <p className="mt-2 text-sm">
                      {form.setupStrike && (
                        <s className="text-muted-foreground">{form.setupStrike}</s>
                      )}{' '}
                      {form.setupText && <span className="font-medium">{form.setupText}</span>}
                    </p>
                  )}
                </div>
                {!form.enabled && (
                  <p className="text-xs text-muted-foreground">Desactivada: no se muestra.</p>
                )}
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={() => void onSave()}
                  disabled={update.isPending || !canEdit || !form.title.trim() || !form.text.trim()}
                >
                  {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                  Guardar
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Logo del header (azul) y del footer (gris oscuro) de la web. */
function LogoCard() {
  const canEdit = useIsSuperadmin();
  const { data } = useAdminPlatformWebsite();
  const upload = useUploadPlatformLogo();
  const reset = useResetPlatformLogo();
  const input = useRef<HTMLInputElement>(null);
  const logoUrl = data?.logoUrl ?? null;

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Sube un PNG, JPG o WebP.');
      return;
    }
    if (file.size > PLATFORM_LOGO_MAX_BYTES) {
      toast.error('El logo no puede pasar de 1 MB.');
      return;
    }
    try {
      await upload.mutateAsync(file);
      toast.success('Logo guardado. La web lo mostrará en un minuto como mucho.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir el logo.');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Logo de la web</CardTitle>
        <CardDescription>
          Se muestra en el header (fondo azul) y en el footer (fondo gris oscuro): usa una versión
          clara o blanca, con fondo transparente. PNG, JPG o WebP de hasta 1 MB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex h-16 items-center rounded-lg bg-primary px-4">
            <PlatformLogo logoUrl={logoUrl} />
          </div>
          <div className="flex h-16 items-center rounded-lg bg-slate-900 px-4">
            <PlatformLogo logoUrl={logoUrl} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button onClick={() => input.current?.click()} disabled={upload.isPending || !canEdit}>
            {upload.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Subir logo
          </Button>
          {data?.logoUrl && (
            <Button
              variant="outline"
              disabled={reset.isPending || !canEdit}
              onClick={() =>
                void reset.mutateAsync().then(() => toast.success('Vuelve el logo de TrasterOS.'))
              }
            >
              Volver al logo de TrasterOS
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const FIELD_TOGGLES: {
  key: 'showPhone' | 'showCompany' | 'showUnits' | 'showProfile';
  label: string;
}[] = [
  { key: 'showPhone', label: 'Teléfono' },
  { key: 'showCompany', label: 'Empresa' },
  { key: 'showUnits', label: 'Cuántos trasteros o viviendas gestiona' },
  { key: 'showProfile', label: 'Qué describe mejor su caso (operador, administrador…)' },
];

/** Destino y campos del formulario de contacto de la portada. */
function ContactSettingsCard() {
  const canEdit = useIsSuperadmin();
  const { data } = useAdminContactSettings();
  const update = useUpdateContactSettings();
  const [form, setForm] = useState<PlatformContactSettingsDto | null>(null);

  useEffect(() => {
    if (data && !form) setForm({ ...data });
  }, [data, form]);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync(form);
      toast.success(
        form.enabled && form.email
          ? 'Guardado. La web mostrará el formulario en un minuto como mucho.'
          : 'Guardado. El formulario no se muestra en la web.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Formulario de contacto</CardTitle>
        <CardDescription>
          Sección «Contacto» de la portada. Cada mensaje llega por email a la dirección que pongas
          (al responder, contestas directamente al visitante) y queda guardado abajo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!form ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Mostrar el formulario en la web
            </label>
            <div className="space-y-1">
              <Label htmlFor="ct-email">Email que recibe los mensajes</Label>
              <Input
                id="ct-email"
                type="email"
                value={form.email}
                placeholder="hola@trasteros.pro"
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {form.enabled && !form.email && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Sin email el formulario no se muestra.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ct-title">Título</Label>
              <Input
                id="ct-title"
                value={form.title}
                maxLength={80}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ct-subtitle">Texto bajo el título</Label>
              <Textarea
                id="ct-subtitle"
                value={form.subtitle}
                maxLength={300}
                onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Campos del formulario</p>
              <p className="text-xs text-muted-foreground">
                Nombre, email, mensaje y la aceptación de la privacidad van siempre.
              </p>
              {FIELD_TOGGLES.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                  />
                  {f.label}
                </label>
              ))}
              {form.showPhone && (
                <label className="ml-6 flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={form.requirePhone}
                    onChange={(e) => setForm({ ...form, requirePhone: e.target.checked })}
                  />
                  Teléfono obligatorio
                </label>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => void onSave()}
                disabled={update.isPending || !canEdit || !form.title.trim()}
              >
                {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                Guardar
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Los mensajes del formulario entran en Tenants → Leads (con su conversación y seguimientos). */
function ContactMessagesCard() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Mensajes recibidos</CardTitle>
        <CardDescription>
          Cada mensaje del formulario entra como lead (o se suma al lead que ya hay con ese email o
          teléfono). Se responden y se siguen desde «Leads».
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" asChild>
          <Link href="/admin/leads">Ir a Leads</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
