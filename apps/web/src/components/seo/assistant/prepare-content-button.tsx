'use client';

import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { openSeoBrief, useSeoAi } from './seo-ai-context';

import type { CreateSeoBriefInput } from '@storageos/shared';

import { seoErrorMessage } from '@/components/seo/seo-errors';
import { Button } from '@/components/ui/button';
import { useCreateSeoBrief } from '@/lib/seo-advanced/assistant-hooks';

/**
 * «Preparar contenido»: genera un brief con IA desde una palabra, una
 * oportunidad, un grupo o una URL y lo abre en la pestaña «Asistente». Solo
 * se ve dentro de la página de un proyecto y si esta persona puede generarlo.
 */
export function PrepareContentButton({
  source,
  size = 'sm',
  variant = 'outline',
}: {
  source: CreateSeoBriefInput;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'default' | 'secondary';
}) {
  const ai = useSeoAi();
  if (!ai?.canGenerate) return null;
  return <PrepareContentInner source={source} size={size} variant={variant} />;
}

function PrepareContentInner({
  source,
  size,
  variant,
}: {
  source: CreateSeoBriefInput;
  size: 'sm' | 'default';
  variant: 'outline' | 'default' | 'secondary';
}) {
  const ai = useSeoAi()!;
  const create = useCreateSeoBrief(ai.scope);
  const run = async () => {
    try {
      const brief = await create.mutateAsync(source);
      toast.success('Brief preparado. Revísalo: está hecho con IA.', {
        action: { label: 'Abrir', onClick: () => openSeoBrief(brief.id) },
      });
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Button size={size} variant={variant} onClick={() => void run()} disabled={create.isPending}>
      {create.isPending ? (
        <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
      ) : (
        <FileText className="mr-1 size-4" aria-hidden />
      )}
      {create.isPending ? 'Preparando…' : 'Preparar contenido'}
    </Button>
  );
}
