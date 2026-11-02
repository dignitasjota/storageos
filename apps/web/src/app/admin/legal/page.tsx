'use client';

import { LEGAL_SLUGS, type LegalSlug } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminLegalDoc, useUpdateLegalDoc } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const SLUG_LABEL: Record<LegalSlug, string> = {
  terms: 'Términos y Condiciones',
  privacy: 'Política de Privacidad',
  cookies: 'Política de Cookies',
  'data-deletion': 'Eliminación de datos',
};

/** Huecos por rellenar del texto de serie: «[NIF]», «[Domicilio social]»… */
function placeholders(content: string): string[] {
  return [...new Set(content.match(/\[[^\]\n]{2,40}\](?!\()/g) ?? [])];
}

export default function AdminLegalPage() {
  const confirm = useConfirm();
  const [tab, setTab] = useState<LegalSlug>('terms');
  const [dirty, setDirty] = useState<Partial<Record<LegalSlug, boolean>>>({});
  const anyDirty = Object.values(dirty).some(Boolean);

  // Aviso al cerrar o recargar la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [anyDirty]);

  async function changeTab(next: string) {
    if (
      dirty[tab] &&
      !(await confirm({ title: 'Tienes cambios sin guardar. ¿Salir igualmente?' }))
    ) {
      return;
    }
    setDirty((d) => ({ ...d, [tab]: false }));
    setTab(next as LegalSlug);
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Páginas legales</h1>
        <p className="text-sm text-muted-foreground">
          El texto (en Markdown) de las páginas legales de trasteros.pro. La web las muestra en unos
          minutos tras guardar. Completa los datos entre corchetes (razón social, NIF, domicilio,
          correo…).
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => void changeTab(v)}>
        <TabsList className="flex h-auto flex-wrap">
          {LEGAL_SLUGS.map((slug) => (
            <TabsTrigger key={slug} value={slug}>
              {SLUG_LABEL[slug]}
              {dirty[slug] && <span className="ml-1 text-amber-600">•</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {LEGAL_SLUGS.map((slug) => (
          <TabsContent key={slug} value={slug} className="mt-4">
            <LegalEditor
              slug={slug}
              onDirtyChange={(v) => setDirty((d) => (d[slug] === v ? d : { ...d, [slug]: v }))}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function LegalEditor({
  slug,
  onDirtyChange,
}: {
  slug: LegalSlug;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const canEdit = useIsSuperadmin();
  const doc = useAdminLegalDoc(slug);
  const update = useUpdateLegalDoc(slug);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);

  // Precargar cuando llegan los datos (o se vuelven a cargar tras guardar).
  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title);
      setContent(doc.data.content);
    }
  }, [doc.data]);

  const dirty = !!doc.data && (title !== doc.data.title || content !== doc.data.content);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const holes = placeholders(content);

  async function save() {
    try {
      await update.mutateAsync({ title: title.trim(), content });
      toast.success('Guardado. La página pública lo mostrará en unos minutos.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  if (doc.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{SLUG_LABEL[slug]}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {doc.data?.updatedAt
              ? `Última actualización: ${formatDateTime(doc.data.updatedAt)}`
              : 'Texto de serie: aún no se ha guardado ninguna versión propia.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Editar' : 'Vista previa'}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={
              update.isPending || !title.trim() || content.trim().length < 20 || !canEdit || !dirty
            }
          >
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {holes.length > 0 && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            Quedan datos por rellenar y se publican tal cual: {holes.join(', ')}.
          </p>
        )}
        {preview ? (
          <div className="rounded-lg border border-border p-4">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">{title}</h2>
            <MarkdownView content={content} />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`title-${slug}`}>Título</Label>
              <Input
                id={`title-${slug}`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`content-${slug}`}>Contenido (Markdown)</Label>
              <textarea
                id={`content-${slug}`}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                className="h-[60vh] w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Markdown: <code># Título</code>, <code>## Sección</code>, <code>- lista</code>,{' '}
                <code>**negrita**</code>, <code>[texto](/enlace)</code>.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
