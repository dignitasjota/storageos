'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/lib/auth/hooks';

export default function SettingsWidgetPage() {
  const me = useMe();
  const slug = me.data?.tenant.slug ?? '';
  const widgetUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/widget/${slug}` : `/widget/${slug}`;

  const iframeSnippet = `<iframe src="${widgetUrl}" width="420" height="640" frameborder="0" title="Reserva tu trastero"></iframe>`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(iframeSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Widget de reserva</h1>
        <p className="text-sm text-muted-foreground">
          Copia este snippet en la web de tu negocio para que tus clientes puedan reservar desde
          ahí.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>URL pública</CardTitle>
          <CardDescription>Solo lectura. Se sirve sin autenticación.</CardDescription>
        </CardHeader>
        <CardContent>
          <Input readOnly value={widgetUrl} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Snippet de embed</CardTitle>
          <CardDescription>
            Pega este HTML en tu web. Permite cualquier origen (iframe abierto).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>Código HTML</Label>
          <textarea
            readOnly
            value={iframeSnippet}
            className="w-full rounded-md border bg-muted/40 p-3 font-mono text-xs"
            rows={3}
          />
          <Button onClick={copy} variant="outline" size="sm">
            {copied ? 'Copiado!' : 'Copiar snippet'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Vista previa</CardTitle>
        </CardHeader>
        <CardContent>
          <iframe src={widgetUrl} width="420" height="640" title="Vista previa" />
        </CardContent>
      </Card>
    </div>
  );
}
