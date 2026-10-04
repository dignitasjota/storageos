'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useTenantBranding, useUpdateTenantBranding } from '@/lib/branding/hooks';

export default function BrandingSettingsPage() {
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();

  const [color, setColor] = useState('#2563eb');
  const [logoUrl, setLogoUrl] = useState('');
  const [siteVerification, setSiteVerification] = useState('');
  const [analyticsId, setAnalyticsId] = useState('');

  useEffect(() => {
    if (branding.data) {
      setColor(branding.data.portalBrandColor ?? '#2563eb');
      setLogoUrl(branding.data.portalLogoUrl ?? '');
      setSiteVerification(branding.data.googleSiteVerification ?? '');
      setAnalyticsId(branding.data.googleAnalyticsId ?? '');
    }
  }, [branding.data]);

  async function saveBranding() {
    try {
      await update.mutateAsync({ portalBrandColor: color, portalLogoUrl: logoUrl });
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
            Personaliza el portal de tus inquilinos y tu web pública con tu logo y color.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Color de marca</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border bg-background"
                aria-label="Color de marca"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-32 font-mono"
                placeholder="#2563eb"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>URL del logo</Label>
            <Input
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://tudominio.com/logo.png"
            />
            <p className="text-xs text-muted-foreground">
              Enlace público a tu logo (PNG/SVG). Déjalo vacío para no mostrar logo.
            </p>
          </div>

          {logoUrl && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Vista previa</Label>
              <div className="flex items-center gap-3 rounded-md border p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt="Logo" className="h-10 w-auto object-contain" />
                <span className="h-1 flex-1 rounded-full" style={{ backgroundColor: color }} />
              </div>
            </div>
          )}

          <Button onClick={saveBranding} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </CardContent>
      </Card>

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
