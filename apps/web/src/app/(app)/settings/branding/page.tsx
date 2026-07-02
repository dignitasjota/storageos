'use client';

import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import { useTenantBranding, useUpdateTenantBranding } from '@/lib/branding/hooks';

export default function BrandingSettingsPage() {
  const branding = useTenantBranding();
  const update = useUpdateTenantBranding();
  const hasCustomDomain = useHasFeature('custom_domain');

  const [color, setColor] = useState('#2563eb');
  const [logoUrl, setLogoUrl] = useState('');
  const [domain, setDomain] = useState('');

  useEffect(() => {
    if (branding.data) {
      setColor(branding.data.portalBrandColor ?? '#2563eb');
      setLogoUrl(branding.data.portalLogoUrl ?? '');
      setDomain(branding.data.customDomain ?? '');
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

  async function saveDomain() {
    try {
      await update.mutateAsync({ customDomain: domain.trim() });
      toast.success(
        domain.trim()
          ? 'Dominio guardado. Lo activaremos cuando el DNS apunte a la plataforma.'
          : 'Dominio propio desactivado.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar el dominio.');
    }
  }

  if (branding.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const savedDomain = branding.data?.customDomain ?? null;
  const verified = branding.data?.customDomainVerifiedAt != null;

  return (
    <div className="max-w-xl space-y-6">
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

      {hasCustomDomain && (
        <Card>
          <CardHeader>
            <CardTitle>Dominio propio</CardTitle>
            <CardDescription>
              Sirve tu web pública bajo tu propio dominio (p. ej. <code>trasteros-garcia.com</code>)
              en vez de la dirección de la plataforma.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label>Tu dominio</Label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="trasteros-garcia.com"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <p className="text-xs text-muted-foreground">
                Sin <code>https://</code> ni rutas. Déjalo vacío para desactivarlo.
              </p>
            </div>

            {savedDomain && (
              <div className="rounded-md border p-3 text-sm">
                {verified ? (
                  <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="size-4" /> Activo — tu web se sirve en{' '}
                    <a
                      href={`https://${savedDomain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline"
                    >
                      {savedDomain}
                    </a>
                  </span>
                ) : (
                  <div className="space-y-2">
                    <span className="inline-flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                      <Clock className="size-4" /> Pendiente de activación
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Crea en tu proveedor de dominios un registro <strong>A</strong> (o CNAME) que
                      apunte <code>{savedDomain}</code> a la plataforma y avísanos: lo activaremos y
                      emitiremos el certificado HTTPS. Te confirmaremos cuando esté listo.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button onClick={saveDomain} disabled={update.isPending}>
                {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Guardar dominio
              </Button>
              {savedDomain && (
                <Badge variant={verified ? 'default' : 'secondary'}>
                  {verified ? 'Verificado' : 'En revisión'}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
