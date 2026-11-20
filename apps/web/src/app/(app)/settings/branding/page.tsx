'use client';

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
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import { useTenantBranding, useUpdateTenantBranding } from '@/lib/branding/hooks';

/** El azul de TrasterOS: lo que se ve cuando el negocio no elige color. */
const DEFAULT_BRAND_COLOR = '#2563eb';

export default function BrandingSettingsPage() {
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();
  const panelBranded = useHasFeature('branded_panel');

  // '' = sin color propio (la web y el portal usan el de TrasterOS).
  const [color, setColor] = useState('');
  const [headerBranded, setHeaderBranded] = useState(false);
  // Enlace pegado a mano; con un logo subido empieza vacío.
  const [pastedLogoUrl, setPastedLogoUrl] = useState('');
  const [siteVerification, setSiteVerification] = useState('');
  const [analyticsId, setAnalyticsId] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Se rellena una sola vez: al subir el logo o guardar una tarjeta se vuelve a
  // pedir la marca y no debe borrar lo que se esté escribiendo en las demás.
  useEffect(() => {
    if (branding.data && !loaded) {
      setLoaded(true);
      setColor(branding.data.portalBrandColor ?? '');
      setHeaderBranded(branding.data.webHeaderBranded);
      setPastedLogoUrl(branding.data.logoUploaded ? '' : (branding.data.portalLogoUrl ?? ''));
      setSiteVerification(branding.data.googleSiteVerification ?? '');
      setAnalyticsId(branding.data.googleAnalyticsId ?? '');
    }
  }, [branding.data, loaded]);

  const colorValid = color.trim() === '' || /^#[0-9a-fA-F]{6}$/.test(color.trim());
  // Lo que se ve en las vistas previas sin color propio.
  const shownColor = color.trim() === '' || !colorValid ? DEFAULT_BRAND_COLOR : color.trim();
  const logoUploaded = branding.data?.logoUploaded ?? false;

  async function saveBranding() {
    try {
      await update.mutateAsync({
        portalBrandColor: color.trim(),
        webHeaderBranded: headerBranded,
        // Con un logo subido, el enlace solo se manda si se ha escrito uno (lo
        // sustituye); vacío deja el subido.
        ...(logoUploaded && pastedLogoUrl.trim() === ''
          ? {}
          : { portalLogoUrl: pastedLogoUrl.trim() }),
      });
      toast.success('Marca del portal actualizada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function saveSeo() {
    try {
      await update.mutateAsync({
        googleSiteVerification: siteVerification.trim(),
        googleAnalyticsId: analyticsId.trim(),
      });
      toast.success('SEO técnico actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  if (branding.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (branding.isError || !branding.data) {
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
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border bg-background"
                aria-label="Color de marca"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-32 font-mono"
                placeholder="Sin color"
                aria-label="Color de marca en formato #RRGGBB"
                aria-invalid={!colorValid}
              />
              {color.trim() !== '' && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setColor('')}>
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
                checked={headerBranded}
                onChange={(e) => setHeaderBranded(e.target.checked)}
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
              style={headerBranded ? { backgroundColor: shownColor, color: '#fff' } : undefined}
              aria-hidden
            >
              <span className="font-semibold">Tu negocio</span>
              <span className="flex items-center gap-3">
                <span className={headerBranded ? 'opacity-80' : 'text-muted-foreground'}>
                  Precios
                </span>
                <span
                  className="rounded px-3 py-1 text-xs font-medium"
                  style={
                    headerBranded
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
            pastedUrl={pastedLogoUrl}
            onPastedUrlChange={setPastedLogoUrl}
            color={shownColor}
          />

          <Button onClick={saveBranding} disabled={update.isPending || !colorValid}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
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
              value={siteVerification}
              onChange={(e) => setSiteVerification(e.target.value)}
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
              value={analyticsId}
              onChange={(e) => setAnalyticsId(e.target.value)}
              placeholder="G-XXXXXXXXXX"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Lo encuentras en Analytics → Administrador → Flujos de datos → tu web.
            </p>
          </div>
          <Button onClick={saveSeo} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
