'use client';

import {
  TENANT_LEGAL_DOCS,
  TENANT_LEGAL_FIELD,
  TENANT_LEGAL_TITLES,
  type TenantLegalDoc,
  type WebLegalSettingsDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateWebLegal, useWebLegal } from '@/lib/web-legal/hooks';

/** Textos legales de la web pública: aviso legal, privacidad y cookies. */
export default function WebLegalPage() {
  const { data, isLoading } = useWebLegal();
  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Textos legales de la web</h1>
        <p className="text-sm text-muted-foreground">
          Aviso legal, privacidad y cookies de tu web pública. Se generan con tus datos de
          facturación y se enlazan en el pie de todas las páginas. Puedes sustituir cada uno por tu
          propio texto; revísalos con tu asesor.
        </p>
      </div>
      {data.missing.length > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Al aviso legal le faltan datos del titular: {data.missing.join(', ')}. Complétalos en{' '}
          <Link href="/settings/company" className="font-medium underline">
            Datos de tu empresa
          </Link>
          .
        </p>
      )}
      <Tabs defaultValue="aviso-legal">
        <TabsList>
          {TENANT_LEGAL_DOCS.map((d) => (
            <TabsTrigger key={d} value={d}>
              {TENANT_LEGAL_TITLES[d]}
            </TabsTrigger>
          ))}
        </TabsList>
        {TENANT_LEGAL_DOCS.map((d) => (
          <TabsContent key={d} value={d} className="mt-4">
            <LegalEditor doc={d} data={data} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function LegalEditor({ doc, data }: { doc: TenantLegalDoc; data: WebLegalSettingsDto }) {
  const field = TENANT_LEGAL_FIELD[doc];
  const saved = data.texts[field] ?? '';
  const [text, setText] = useState(saved);
  const update = useUpdateWebLegal();
  const custom = text.trim().length > 0;

  async function save(value: string) {
    try {
      await update.mutateAsync({ [field]: value });
      toast.success(value ? 'Texto guardado.' : 'Se usa de nuevo el texto generado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Texto propio (Markdown)</CardTitle>
          <CardDescription>
            Vacío = se publica el texto generado. Usa «##» para los apartados.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={18}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Deja este campo vacío para usar el texto generado."
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void save(text.trim())}
              disabled={update.isPending || text === saved}
            >
              Guardar
            </Button>
            <Button variant="outline" onClick={() => setText(data.generated[doc])}>
              Partir del texto generado
            </Button>
            {saved && (
              <Button
                variant="ghost"
                onClick={() => {
                  setText('');
                  void save('');
                }}
              >
                Volver al generado
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Vista previa {custom ? '(tu texto)' : '(texto generado)'}
          </CardTitle>
        </CardHeader>
        <CardContent className="max-h-[32rem] overflow-y-auto">
          <MarkdownView content={custom ? text : data.generated[doc]} />
        </CardContent>
      </Card>
    </div>
  );
}
