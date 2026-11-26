'use client';

import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SeoOrigin } from './seo-origin';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCount } from '@/lib/format';
import {
  type SistrixScope,
  useAddKeywords,
  useSistrixOpportunities,
} from '@/lib/seo-advanced/sistrix-hooks';
import { cn } from '@/lib/utils';

/**
 * Oportunidades e ideas de palabras de SISTRIX para tu dominio principal, con
 * «Añadir a mis palabras». El motor propio de oportunidades llega aparte.
 */
export function OpportunitiesPanel({ scope, canEdit }: { scope: SistrixScope; canEdit: boolean }) {
  const [kind, setKind] = useState<'opportunity' | 'idea'>('opportunity');
  const list = useSistrixOpportunities(scope, kind);
  const add = useAddKeywords(scope);

  const addOne = async (keyword: string) => {
    try {
      await add.mutateAsync({
        keywords: [keyword],
        source: kind === 'idea' ? 'sistrix_ideas' : 'sistrix_opportunities',
      });
      toast.success(`«${keyword}» añadida a tus palabras`);
      void list.refetch();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Tipo de lista">
        {(['opportunity', 'idea'] as const).map((k) => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant={kind === k ? 'secondary' : 'ghost'}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
          >
            {k === 'opportunity' ? 'Oportunidades' : 'Ideas de palabras'}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {kind === 'opportunity'
          ? 'Palabras en las que tu web está cerca de la primera página: un empujón puede traer visitas. «Ganancia» es lo que estima SISTRIX que ganarías.'
          : 'Palabras relacionadas con tu web que aún no trabajas (se piden a mano: «Ideas de palabras» en Sincronizar).'}
      </p>
      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : !list.data?.origin ? (
        <p className="text-sm text-muted-foreground">
          {list.data?.domain
            ? 'Aún no hay datos. Sincronízalos arriba (los dominios pequeños pueden no estar en la muestra de SISTRIX).'
            : 'Añade antes el dominio principal del proyecto.'}
        </p>
      ) : (
        <>
          <SeoOrigin origin={list.data.origin} />
          <ul className="divide-y rounded-md border">
            {list.data.items.map((o) => (
              <li
                key={o.keyword}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <span className="font-medium">{o.keyword}</span>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {o.position !== null && <span>Posición {o.position}</span>}
                    {o.gain !== null && <span>Ganancia {formatCount(o.gain)}</span>}
                    {o.competition !== null && <span>Competencia {o.competition}/100</span>}
                    {o.traffic !== null && <span>Búsquedas {formatCount(o.traffic)}</span>}
                  </div>
                  {o.url && (
                    <span className="block break-all text-xs text-muted-foreground">{o.url}</span>
                  )}
                </div>
                {o.inProject ? (
                  <Badge variant="secondary" className={cn('self-start sm:self-center')}>
                    Ya en tus palabras
                  </Badge>
                ) : (
                  canEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start sm:self-center"
                      disabled={add.isPending}
                      onClick={() => void addOne(o.keyword)}
                    >
                      <Plus className="mr-1 size-4" aria-hidden /> Añadir a mis palabras
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
