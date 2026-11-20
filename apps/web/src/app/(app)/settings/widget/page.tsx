'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHasFeature, useMe } from '@/lib/auth/hooks';
import { useTenantBranding } from '@/lib/branding/hooks';

export default function SettingsWidgetPage() {
  const me = useMe();
  const branding = useTenantBranding();
  const hasCustomDomain = useHasFeature('custom_domain');
  const slug = me.data?.tenant.slug ?? '';

  // Con dominio propio activo, el widget se sirve desde él; si no, desde
  // la plataforma.
  const domain =
    hasCustomDomain && branding.data?.customDomainVerifiedAt ? branding.data.customDomain : null;
  const origin = domain
    ? `https://${domain}`
    : typeof window !== 'undefined'
      ? window.location.origin
      : '';
  const widgetUrl = `${origin}/widget/${slug}`;
  // La vista previa, siempre desde la plataforma (el panel no puede mostrar en
  // un recuadro páginas de otros dominios).
  const previewUrl = `/widget/${slug}`;

  const iframeCode = `<iframe src="${widgetUrl}" width="420" height="640" frameborder="0" title="Reserva tu trastero"></iframe>`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(iframeCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Widget para tu web</h1>
        <p className="text-sm text-muted-foreground">
          Un recuadro con tus trasteros, sus precios y un formulario de contacto que puedes poner en
          otra web (por ejemplo, la que ya tienes). Desde él tus clientes ven lo que tienes libre,
          reservan o te dejan sus datos para que les llames.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Dirección del widget</CardTitle>
          <CardDescription>
            Cualquiera puede abrirla, sin entrar con usuario. Puedes compartirla tal cual.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input readOnly value={widgetUrl} aria-label="Dirección del widget" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Código para pegar en tu web</CardTitle>
          <CardDescription>
            Pásale este código a quien te lleve la web (o pégalo tú en un bloque «HTML» de tu gestor
            de contenidos). El widget sale en la página donde lo pongas.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="widget-code">Código</Label>
          <textarea
            id="widget-code"
            readOnly
            value={iframeCode}
            className="w-full rounded-md border bg-muted/40 p-3 font-mono text-xs"
            rows={3}
          />
          <Button onClick={copy} variant="outline" size="sm">
            {copied ? 'Copiado' : 'Copiar el código'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Así se verá</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {slug && <iframe src={previewUrl} width="420" height="640" title="Vista previa" />}
        </CardContent>
      </Card>
    </div>
  );
}
