'use client';

import { PLATFORM_LOGO_MAX_BYTES, type PlatformFounderOfferDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PlatformLogo } from '@/components/public/platform-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminFounderOffer,
  useAdminPlatformWebsite,
  useResetPlatformLogo,
  useUpdateFounderOffer,
  useUploadPlatformLogo,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Ajustes de la web pública de TrasterOS (no las webs de los tenants). */
export default function AdminWebsitePage() {
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
        <h1 className="text-2xl font-semibold tracking-tight">Web de TrasterOS</h1>
        <p className="text-sm text-muted-foreground">
          Lo que aparece en trasteros.pro (no afecta a las webs de los tenants).
        </p>
      </div>

      <LogoCard />

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
                  disabled={update.isPending || !form.title.trim() || !form.text.trim()}
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
          <Button onClick={() => input.current?.click()} disabled={upload.isPending}>
            {upload.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Subir logo
          </Button>
          {data?.logoUrl && (
            <Button
              variant="outline"
              disabled={reset.isPending}
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
