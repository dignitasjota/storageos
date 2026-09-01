'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSeoChecklist } from '@/lib/analytics/hooks';

/**
 * Aviso compacto del checklist de SEO on-page (`/analytics?tab=seo`) — sin
 * esto, la única forma de descubrirlo era entrar a Analítica y cambiar de
 * pestaña. `web_premium` cuenta solo si el tenant la tiene activada (si no,
 * el checklist premium ni siquiera es alcanzable, así que no penaliza el
 * score mostrado aquí).
 */
export function SeoNudgeCard() {
  const q = useSeoChecklist();

  if (q.isLoading || !q.data) {
    return <Skeleton className="h-16 rounded-xl" />;
  }

  const d = q.data;
  const done = d.baseScore.done + (d.hasWebPremium ? d.premiumScore.done : 0);
  const total = d.baseScore.total + (d.hasWebPremium ? d.premiumScore.total : 0);
  const pct = total === 0 ? 1 : done / total;

  // Todo hecho: no molestamos con un aviso de "mejora tu SEO" sin nada que mejorar.
  if (pct === 1) return null;

  const tone =
    pct >= 0.7 ? 'bg-amber-500/10 text-amber-600' : 'bg-red-500/10 text-red-600 dark:text-red-400';

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
            <Search className="size-4.5" />
          </span>
          <div>
            <p className="text-sm font-medium">
              Tu web pública tiene {done}/{total} puntos de SEO
            </p>
            <p className="text-xs text-muted-foreground">
              Horario, fotos, reseñas, FAQ… señales que ya tienes listas para activar.
            </p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href="/analytics?tab=seo">Mejorar SEO →</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
