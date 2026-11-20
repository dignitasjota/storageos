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
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { TermsVersionsCard } from './versions-card';

import { SectionError } from '@/components/dashboard/section-state';
import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateWebLegal, useWebLegal } from '@/lib/web-legal/hooks';

/** Textos legales de la web pública: aviso legal, privacidad, cookies y condiciones. */
export default function WebLegalPage() {
  const { data, isLoading, isError, refetch } = useWebLegal();
  // Lo escrito en cada pestaña vive aquí: cambiar de pestaña no lo pierde.
  const [drafts, setDrafts] = useState<Partial<Record<TenantLegalDoc, string>>>({});
  const savedOf = (d: TenantLegalDoc) => data?.texts[TENANT_LEGAL_FIELD[d]] ?? '';
  const textOf = (d: TenantLegalDoc) => drafts[d] ?? savedOf(d);
  const anyDirty = data ? TENANT_LEGAL_DOCS.some((d) => textOf(d) !== savedOf(d)) : false;

  // Aviso al cerrar o recargar la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [anyDirty]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError || !data) {
    return <SectionError onRetry={() => void refetch()} />;
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Textos legales de la web</h1>
        <p className="text-sm text-muted-foreground">
          Aviso legal, privacidad, cookies y condiciones generales de contratación de tu web
          pública. Se generan con tus datos de facturación y se enlazan en el pie de todas las
          páginas. Puedes sustituir cada uno por tu propio texto; revísalos con tu asesor.
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
        <TabsList className="h-auto flex-wrap">
          {TENANT_LEGAL_DOCS.map((d) => (
            <TabsTrigger key={d} value={d}>
              {TENANT_LEGAL_TITLES[d]}
              {textOf(d) !== savedOf(d) && (
                <span
                  className="ml-1.5 size-1.5 rounded-full bg-amber-500"
                  aria-label="Sin guardar"
                />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {TENANT_LEGAL_DOCS.map((d) => (
          <TabsContent key={d} value={d} className="mt-4 space-y-4">
            <LegalEditor
              doc={d}
              data={data}
              text={textOf(d)}
              setText={(value) => setDrafts((prev) => ({ ...prev, [d]: value }))}
              onSaved={() =>
                setDrafts((prev) => {
                  const next = { ...prev };
                  delete next[d];
                  return next;
                })
              }
            />
            {d === 'condiciones-contratacion' && !data.texts.terms && (
              <p className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-100">
                Mientras uses el texto por defecto, se rellena con los datos de tu empresa y de tus
                locales: si los cambias (o das de alta un local), el texto cambia y quien lo acepte
                a partir de entonces aceptará una versión nueva. Para que solo cambie cuando tú lo
                decidas, guarda tu propio texto.
              </p>
            )}
            {d === 'condiciones-contratacion' && <TermsVersionsCard />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function LegalEditor({
  doc,
  data,
  text,
  setText,
  onSaved,
}: {
  doc: TenantLegalDoc;
  data: WebLegalSettingsDto;
  text: string;
  setText: (value: string) => void;
  onSaved: () => void;
}) {
  const field = TENANT_LEGAL_FIELD[doc];
  const saved = data.texts[field] ?? '';
  const update = useUpdateWebLegal();
  const custom = text.trim().length > 0;

  async function save(value: string) {
    try {
      await update.mutateAsync({ [field]: value });
      onSaved();
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
