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

import { TermsVersionsCard } from './versions-card';

import { SectionError } from '@/components/dashboard/section-state';
import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { UnsavedChangesBar } from '@/components/unsaved-changes-bar';
import { ApiError } from '@/lib/auth/api';
import { runSaveSteps, useUnsavedChangesGuard } from '@/lib/unsaved-changes';
import { useUpdateWebLegal, useWebLegal } from '@/lib/web-legal/hooks';

/** Textos legales de la web pública: aviso legal, privacidad, cookies y condiciones. */
export default function WebLegalPage() {
  const { data, isLoading, isError, refetch } = useWebLegal();
  // Lo escrito en cada pestaña vive aquí: cambiar de pestaña no lo pierde.
  const [drafts, setDrafts] = useState<Partial<Record<TenantLegalDoc, string>>>({});
  const savedOf = (d: TenantLegalDoc) => data?.texts[TENANT_LEGAL_FIELD[d]] ?? '';
  const textOf = (d: TenantLegalDoc) => drafts[d] ?? savedOf(d);
  const changedDocs = data ? TENANT_LEGAL_DOCS.filter((d) => textOf(d) !== savedOf(d)) : [];
  const anyDirty = changedDocs.length > 0;
  const update = useUpdateWebLegal();
  const [saving, setSaving] = useState(false);
  useUnsavedChangesGuard(anyDirty);

  /** Guarda cada texto cambiado; si uno falla, sigue escrito y se dice cuál. */
  async function save() {
    setSaving(true);
    const done: TenantLegalDoc[] = [];
    const failed = await runSaveSteps(
      changedDocs.map((d) => ({
        label: TENANT_LEGAL_TITLES[d],
        run: async () => {
          await update.mutateAsync({ [TENANT_LEGAL_FIELD[d]]: textOf(d).trim() });
          done.push(d);
        },
      })),
      (err) => (err instanceof ApiError ? err.body.message : 'No se pudo guardar.'),
    );
    setSaving(false);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const d of done) delete next[d];
      return next;
    });
    if (failed.length > 0) {
      toast.error(failed.map((f) => `${f.label}: ${f.message}`).join(' · '));
      return;
    }
    toast.success('Textos legales guardados.');
  }

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
      <UnsavedChangesBar
        dirty={anyDirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => setDrafts({})}
      />
    </div>
  );
}

function LegalEditor({
  doc,
  data,
  text,
  setText,
}: {
  doc: TenantLegalDoc;
  data: WebLegalSettingsDto;
  text: string;
  setText: (value: string) => void;
}) {
  const saved = data.texts[TENANT_LEGAL_FIELD[doc]] ?? '';
  const custom = text.trim().length > 0;

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
            <Button variant="outline" onClick={() => setText(data.generated[doc])}>
              Partir del texto generado
            </Button>
            {(saved || text) && (
              <Button variant="ghost" onClick={() => setText('')}>
                Volver al generado
              </Button>
            )}
          </div>
          {saved && !text.trim() && (
            <p className="text-xs text-muted-foreground">
              Al guardar se publicará otra vez el texto generado.
            </p>
          )}
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
