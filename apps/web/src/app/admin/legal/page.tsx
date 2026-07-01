'use client';

import { LEGAL_SLUGS, type LegalSlug } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminLegalDoc, useUpdateLegalDoc } from '@/lib/admin/hooks';

const SLUG_LABEL: Record<LegalSlug, string> = {
  terms: 'Términos y Condiciones',
  privacy: 'Política de Privacidad',
};

export default function AdminLegalPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Páginas legales</h1>
        <p className="text-sm text-muted-foreground">
          Edita el texto (en Markdown) de las páginas públicas de Términos y Privacidad. Los cambios
          se publican al guardar. Recuerda completar los datos entre corchetes (razón social, NIF,
          domicilio, correo…).
        </p>
      </div>

      <Tabs defaultValue="terms">
        <TabsList>
          {LEGAL_SLUGS.map((slug) => (
            <TabsTrigger key={slug} value={slug}>
              {SLUG_LABEL[slug]}
            </TabsTrigger>
          ))}
        </TabsList>
        {LEGAL_SLUGS.map((slug) => (
          <TabsContent key={slug} value={slug} className="mt-4">
            <LegalEditor slug={slug} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function LegalEditor({ slug }: { slug: LegalSlug }) {
  const doc = useAdminLegalDoc(slug);
  const update = useUpdateLegalDoc(slug);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);

  // Precargar cuando llegan los datos (o cambia de pestaña).
  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title);
      setContent(doc.data.content);
    }
  }, [doc.data]);

  async function save() {
    try {
      await update.mutateAsync({ title: title.trim(), content });
      toast.success('Guardado. La página pública ya muestra el nuevo texto.');
    } catch {
      toast.error('No se pudo guardar. Inténtalo de nuevo.');
    }
  }

  if (doc.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{SLUG_LABEL[slug]}</CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Editar' : 'Vista previa'}
          </Button>
          <Button size="sm" onClick={save} disabled={update.isPending || !title.trim()}>
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
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
