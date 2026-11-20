'use client';

import { type TenantBrandingResponse, type UpdateTenantBrandingInput } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { FaviconCard } from './favicon-card';
import { LogoField } from './logo-field';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UnsavedChangesBar } from '@/components/unsaved-changes-bar';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import { useTenantBranding, useUpdateTenantBranding } from '@/lib/branding/hooks';
import { runSaveSteps, useUnsavedChangesGuard } from '@/lib/unsaved-changes';

/** El azul de TrasterOS: lo que se ve cuando el negocio no elige color. */
const DEFAULT_BRAND_COLOR = '#2563eb';

/** Todo lo que se edita en la página (se guarda de una vez con la barra de abajo). */
interface BrandingForm {
  /** '' = sin color propio (la web y el portal usan el de TrasterOS). */
  color: string;
  headerBranded: boolean;
  /** Enlace pegado a mano; con un logo subido empieza vacío. */
  pastedLogoUrl: string;
  siteVerification: string;
  analyticsId: string;
}

function formFrom(d: TenantBrandingResponse): BrandingForm {
  return {
    color: d.portalBrandColor ?? '',
    headerBranded: d.webHeaderBranded,
    pastedLogoUrl: d.logoUploaded ? '' : (d.portalLogoUrl ?? ''),
    siteVerification: d.googleSiteVerification ?? '',
    analyticsId: d.googleAnalyticsId ?? '',
  };
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo guardar.';
}

export default function BrandingSettingsPage() {
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();
  const panelBranded = useHasFeature('branded_panel');

  // Se rellena una sola vez: al subir el logo o el favicon se vuelve a pedir la
  // marca y no debe borrar lo que se esté escribiendo.
  const [form, setForm] = useState<BrandingForm | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = branding.data ? formFrom(branding.data) : null;
  const dirty = form !== null && saved !== null && JSON.stringify(form) !== JSON.stringify(saved);
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    if (branding.data && form === null) setForm(formFrom(branding.data));
  }, [branding.data, form]);

  function set<K extends keyof BrandingForm>(key: K, value: BrandingForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  const color = form?.color ?? '';
  const colorValid = color.trim() === '' || /^#[0-9a-fA-F]{6}$/.test(color.trim());
  // Lo que se ve en las vistas previas sin color propio.
  const shownColor = color.trim() === '' || !colorValid ? DEFAULT_BRAND_COLOR : color.trim();
  const logoUploaded = branding.data?.logoUploaded ?? false;

  async function save() {
    if (!form || !saved) return;
    const brand: UpdateTenantBrandingInput = {};
    if (form.color !== saved.color) brand.portalBrandColor = form.color.trim();
    if (form.headerBranded !== saved.headerBranded) brand.webHeaderBranded = form.headerBranded;
    // Con un logo subido, el enlace solo se manda si se ha escrito uno (lo
    // sustituye); vacío deja el subido.
    if (form.pastedLogoUrl !== saved.pastedLogoUrl) {
      brand.portalLogoUrl = form.pastedLogoUrl.trim();
    }
    const seo: UpdateTenantBrandingInput = {};
    if (form.siteVerification !== saved.siteVerification) {
      seo.googleSiteVerification = form.siteVerification.trim();
    }
    if (form.analyticsId !== saved.analyticsId) seo.googleAnalyticsId = form.analyticsId.trim();

    setSaving(true);
    const result: { latest: TenantBrandingResponse | null } = { latest: null };
    const failed = await runSaveSteps(
      [
        ...(Object.keys(brand).length > 0
          ? [
              {
                label: 'Marca del portal y la web',
                run: async () => {
                  result.latest = await update.mutateAsync(brand);
                },
              },
            ]
          : []),
        ...(Object.keys(seo).length > 0
          ? [
              {
                label: 'SEO técnico',
                run: async () => {
                  result.latest = await update.mutateAsync(seo);
                },
              },
            ]
          : []),
      ],
      errorMessage,
    );
    setSaving(false);
    if (result.latest) {
      // Lo guardado pasa a ser la base; lo que falló sigue escrito.
      const base = formFrom(result.latest);
      setForm((f) => {
        if (!f) return f;
        const next = { ...f };
        if (!failed.some((x) => x.label === 'Marca del portal y la web')) {
          next.color = base.color;
          next.headerBranded = base.headerBranded;
          next.pastedLogoUrl = base.pastedLogoUrl;
        }
        if (!failed.some((x) => x.label === 'SEO técnico')) {
          next.siteVerification = base.siteVerification;
          next.analyticsId = base.analyticsId;
        }
        return next;
      });
    }
    if (failed.length > 0) {
      toast.error(failed.map((f) => `${f.label}: ${f.message}`).join(' · '));
      return;
    }
    toast.success('Cambios guardados.');
  }

  if (branding.isLoading || (branding.data && !form)) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (branding.isError || !branding.data || !form) {
    return <SectionError onRetry={() => void branding.refetch()} />;
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Marca y SEO</h1>
        <p className="text-sm text-muted-foreground">
          Tu logo y color en la web pública, el portal de tus inquilinos y los correos que les
          llegan, y la conexión de tu web con Google.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Marca del portal y la web pública</CardTitle>
          <CardDescription>
            Personaliza el portal de tus inquilinos y tu web pública con tu logo y color.{' '}
            {panelBranded ? (
              'Tu logo también sale en el menú de este panel y en la app que instala tu equipo.'
            ) : (
              <>
                Con el plan Pro, también en el panel de tu equipo y en su app.{' '}
                <Link href="/settings/saas-billing" className="underline">
                  Ver planes
                </Link>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Color de marca</Label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="color"
                value={shownColor}
                onChange={(e) => set('color', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border bg-background"
                aria-label="Color de marca"
              />
              <Input
                value={color}
                onChange={(e) => set('color', e.target.value)}
                className="w-32 font-mono"
                placeholder="Sin color"
                aria-label="Color de marca en formato #RRGGBB"
                aria-invalid={!colorValid}
              />
              {color.trim() !== '' && (
                <Button type="button" variant="ghost" size="sm" onClick={() => set('color', '')}>
                  Quitar color
                </Button>
              )}
            </div>
            {!colorValid ? (
              <p className="text-xs text-destructive">
                Escribe el color en formato #RRGGBB (por ejemplo #2563eb).
              </p>
            ) : color.trim() === '' ? (
              <p className="text-xs text-muted-foreground">
                Sin color propio: tu web y el portal usan el azul de TrasterOS.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={form.headerBranded}
                onChange={(e) => set('headerBranded', e.target.checked)}
              />
              <span>
                <span className="font-medium">Cabecera de la web con el color de marca</span>
                <span className="block text-xs text-muted-foreground">
                  El menú de tu web pública se pinta con tu color y el botón «Reservar» pasa a
                  blanco para que destaque.
                </span>
              </span>
            </label>
            <div
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              style={
                form.headerBranded ? { backgroundColor: shownColor, color: '#fff' } : undefined
              }
              aria-hidden
            >
              <span className="font-semibold">Tu negocio</span>
              <span className="flex items-center gap-3">
                <span className={form.headerBranded ? 'opacity-80' : 'text-muted-foreground'}>
                  Precios
                </span>
                <span
                  className="rounded px-3 py-1 text-xs font-medium"
                  style={
                    form.headerBranded
                      ? { backgroundColor: '#fff', color: shownColor }
                      : { backgroundColor: shownColor, color: '#fff' }
                  }
                >
                  Reservar
                </span>
              </span>
            </div>
          </div>

          <LogoField
            savedLogoUrl={branding.data?.portalLogoUrl ?? null}
            logoUploaded={logoUploaded}
            pastedUrl={form.pastedLogoUrl}
            onPastedUrlChange={(v) => set('pastedLogoUrl', v)}
            color={shownColor}
          />
        </CardContent>
      </Card>

      <FaviconCard faviconUrl={branding.data?.faviconUrl ?? null} />

      <Card>
        <CardHeader>
          <CardTitle>SEO técnico (Google)</CardTitle>
          <CardDescription>
            Conecta tu web pública a las herramientas gratuitas de Google. Disponible en cualquier
            plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Verificación de Google Search Console</Label>
            <Input
              value={form.siteVerification}
              onChange={(e) => set('siteVerification', e.target.value)}
              placeholder="Contenido de la etiqueta meta (sin el HTML)"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              En Search Console, elige el método &quot;Etiqueta HTML&quot; y pega aquí solo el valor
              de <code>content=&quot;...&quot;</code>.
            </p>
          </div>
          <div className="space-y-1">
            <Label>ID de medición de Google Analytics 4</Label>
            <Input
              value={form.analyticsId}
              onChange={(e) => set('analyticsId', e.target.value)}
              placeholder="G-XXXXXXXXXX"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Lo encuentras en Analytics → Administrador → Flujos de datos → tu web.
            </p>
          </div>
        </CardContent>
      </Card>

      <UnsavedChangesBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => saved && setForm(saved)}
        canSave={colorValid}
        hint={colorValid ? undefined : 'Escribe el color en formato #RRGGBB.'}
      />
    </div>
  );
}
