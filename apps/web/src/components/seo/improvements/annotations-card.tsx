'use client';

import { SEO_SITE_CHANGE_TYPE_LABELS, type SeoSiteChangeType } from '@storageos/shared';
import { Check, History, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import {
  useAnnotationActions,
  useAnnotationProposals,
  type ImprovementScope,
} from '@/lib/seo-advanced/improvement-hooks';

/**
 * Actuaciones propuestas desde el registro de actividad (mejora 6): lo que el
 * negocio cambia en su web (SEO de la web, blog, páginas de zona) aparece aquí
 * ya rellenado. Nunca se apunta nada sin confirmarlo, y lo descartado no vuelve.
 */
export function SeoAnnotationProposalsCard({
  scope,
  canEdit,
}: {
  scope: ImprovementScope;
  canEdit: boolean;
}) {
  const data = useAnnotationProposals(scope);
  const { confirm, dismiss } = useAnnotationActions(scope);
  const items = data.data?.items ?? [];
  // Sin propuestas (o en la plataforma, que no tiene registro de actividad), la tarjeta no ocupa sitio.
  if (data.isLoading || data.isError || items.length === 0) return null;

  const ok = async (ref: string) => {
    try {
      await confirm.mutateAsync(ref);
      toast.success('Actuación apuntada');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const no = async (refs: string[]) => {
    try {
      await dismiss.mutateAsync(refs);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card id="anotaciones">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" aria-hidden /> Cambios detectados en tu web
          <Badge variant="secondary" className="font-normal">
            {items.length}
          </Badge>
        </CardTitle>
        <CardDescription>
          Esto es lo que has cambiado en TrasterOS y puede afectar a Google. Confírmalo para
          apuntarlo como actuación y ver después cómo ha ido; si no quieres apuntarlo, descártalo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {canEdit && items.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={dismiss.isPending}
            onClick={() => void no(items.map((i) => i.sourceRef))}
          >
            Descartarlos todos
          </Button>
        )}
        <ul className="divide-y rounded-md border">
          {items.map((p) => (
            <li key={p.sourceRef} className="space-y-1 p-3 text-sm">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{p.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(p.changeDate)}
                    {p.changeTime ? ` a las ${p.changeTime}` : ''} ·{' '}
                    {SEO_SITE_CHANGE_TYPE_LABELS[p.type as SeoSiteChangeType] ?? p.type} ·{' '}
                    {p.origin}
                  </p>
                  {p.urls.length > 0 && (
                    <p className="break-all text-xs text-muted-foreground">{p.urls.join(', ')}</p>
                  )}
                </div>
                {canEdit && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      disabled={confirm.isPending}
                      onClick={() => void ok(p.sourceRef)}
                    >
                      {confirm.isPending ? (
                        <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
                      ) : (
                        <Check className="mr-1 size-4" aria-hidden />
                      )}
                      Confirmar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={dismiss.isPending}
                      onClick={() => void no([p.sourceRef])}
                    >
                      <X className="mr-1 size-4" aria-hidden /> Descartar
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
