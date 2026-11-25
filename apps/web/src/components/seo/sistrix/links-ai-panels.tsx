'use client';

import { Loader2 } from 'lucide-react';

import { SeoOrigin } from './seo-origin';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { formatCount } from '@/lib/format';
import {
  type SistrixScope,
  useSistrixAiVisibility,
  useSistrixBacklinks,
} from '@/lib/seo-advanced/sistrix-hooks';

const AI_MODELS: Record<string, string> = {
  aio: 'Google AI Overviews',
  ai_mode: 'Google AI Mode',
  aimode: 'Google AI Mode',
  chatgpt: 'ChatGPT',
};

/** Páginas de tu web que más enlaces reciben (con cuántos dominios distintos enlazan). */
export function BacklinksPanel({ scope }: { scope: SistrixScope }) {
  const links = useSistrixBacklinks(scope);
  if (links.isError) return <SectionError onRetry={() => void links.refetch()} />;
  if (links.isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  if (!links.data?.origin) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay enlaces descargados. Sincroniza «Enlaces».
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <SeoOrigin origin={links.data.origin} />
      <ul className="divide-y rounded-md border">
        {links.data.items.map((l) => (
          <li
            key={l.url}
            className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0 break-all text-sm">{l.url}</span>
            <span className="flex shrink-0 gap-3 text-xs text-muted-foreground tabular-nums">
              <span>{formatCount(l.domains)} dominios</span>
              <span>{formatCount(l.links)} enlaces</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** En cuántas respuestas de buscadores de IA aparece cada dominio (`ai_check`). */
export function AiVisibilityPanel({ scope }: { scope: SistrixScope }) {
  const ai = useSistrixAiVisibility(scope);
  if (ai.isError) return <SectionError onRetry={() => void ai.refetch()} />;
  if (ai.isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  if (!ai.data?.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay datos. Sincroniza «Visibilidad en IA».
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Preguntas a ChatGPT y a las respuestas con IA de Google en las que se nombra cada dominio.
      </p>
      <ul className="divide-y rounded-md border">
        {ai.data.map((r) => (
          <li key={r.domain} className="space-y-1 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-medium">{r.domain}</span>
              {r.own && <Badge variant="secondary">Tú</Badge>}
              <span className="text-sm tabular-nums">{formatCount(r.promptCount)} respuestas</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {r.models.map((m) => (
                <span key={m.model}>
                  {AI_MODELS[m.model] ?? m.model}: {formatCount(m.promptCount)}
                </span>
              ))}
              <SeoOrigin origin={r} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
