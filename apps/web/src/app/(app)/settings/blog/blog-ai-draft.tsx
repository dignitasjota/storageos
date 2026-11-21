'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { BlogPostDraftDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useDraftBlogPost } from '@/lib/blog/hooks';

/**
 * «Redactar con IA»: a partir de un tema y unas palabras clave propone la
 * entrada con los datos reales del negocio. Gasta una consulta del asistente y
 * no guarda nada: rellena el formulario para revisarlo.
 */
export function BlogAiDraft({
  onDraft,
}: {
  /** Aplica el borrador; devuelve false si el usuario no quiere sustituir lo escrito. */
  onDraft: (draft: BlogPostDraftDto) => Promise<boolean>;
}) {
  const draft = useDraftBlogPost();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const [keywords, setKeywords] = useState('');

  async function run() {
    try {
      const d = await draft.mutateAsync({ topic: topic.trim(), keywords: keywords.trim() });
      if (await onDraft(d)) {
        toast.success('Borrador listo. Revísalo antes de guardar.');
        setOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo redactar la entrada.');
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="mr-1 h-4 w-4" /> Redactar con IA
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="flex items-center gap-1 text-sm font-medium">
        <Sparkles className="h-4 w-4" /> Redactar con IA
      </p>
      <p className="text-xs text-muted-foreground">
        Escribimos el título, el resumen, el texto y los textos para Google con tus locales, tamaños
        y precios reales. Gasta una consulta del asistente. Revísalo antes de guardar.
      </p>
      <div className="space-y-1">
        <Label htmlFor="blog-ai-topic">¿De qué va la entrada?</Label>
        <Input
          id="blog-ai-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={300}
          placeholder="Cómo guardar los muebles durante una mudanza"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="blog-ai-keywords">Palabras clave (opcional)</Label>
        <Input
          id="blog-ai-keywords"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          maxLength={300}
          placeholder="trastero para mudanza, guardamuebles"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void run()}
          disabled={draft.isPending || topic.trim().length < 3}
        >
          {draft.isPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-4 w-4" />
          )}
          {draft.isPending ? 'Redactando…' : 'Redactar'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={draft.isPending}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
