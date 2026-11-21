'use client';

import {
  FEATURE_LABELS,
  PRODUCT_UPDATE_CATEGORY_LABELS,
  type ProductUpdateDto,
} from '@storageos/shared';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { SectionError } from '@/components/dashboard/section-state';
import { MarkdownView } from '@/components/public/markdown-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PLANS_HREF, useRouteAccess } from '@/lib/navigation/route-access';
import { useMarkProductUpdatesSeen, useProductUpdatesPages } from '@/lib/product-updates/hooks';

const CATEGORY_CLASS: Record<ProductUpdateDto['category'], string> = {
  new: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  improvement: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  fix: 'bg-muted text-muted-foreground',
};

export default function ProductUpdatesPage() {
  const updates = useProductUpdatesPages();
  const markSeen = useMarkProductUpdatesSeen();
  const access = useRouteAccess();
  const marked = useRef(false);
  // Hasta cuándo estaban leídas al abrir la página, tomado de la primera carga
  // de esta visita (no de la caché de otra anterior). Aunque luego la lista se
  // recargue (ya marcada como vista) o se pidan más páginas, se sigue viendo
  // qué era nuevo.
  const [readUntil, setReadUntil] = useState<string | null>(null);
  const fresh = updates.isFetchedAfterMount && updates.isSuccess;
  const firstReadUntil = updates.data?.pages[0]?.readUntil ?? null;

  useEffect(() => {
    if (!fresh || marked.current || !firstReadUntil) return;
    marked.current = true;
    setReadUntil(firstReadUntil);
    markSeen.mutate();
  }, [fresh, firstReadUntil, markSeen]);

  const isUnread = (u: ProductUpdateDto) =>
    readUntil ? new Date(u.publishedAt) > new Date(readUntil) : u.unread;
  const canSeePlans = access(PLANS_HREF).allowed;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" />
          Novedades
        </h1>
        <p className="text-sm text-muted-foreground">
          Lo último que hemos añadido y mejorado en TrasterOS.
        </p>
      </div>

      {updates.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : updates.isError && updates.rows.length === 0 ? (
        <Card>
          <CardContent>
            <SectionError onRetry={() => void updates.refetch()} />
          </CardContent>
        </Card>
      ) : updates.rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Todavía no hay novedades publicadas.
          </CardContent>
        </Card>
      ) : (
        <>
          {updates.rows.map((u) => {
            const unread = isUnread(u);
            const link = u.link ? access(u.link) : null;
            // La función que falta: la de la novedad o la que pide la página enlazada.
            const missing =
              u.feature && u.featureIncluded === false
                ? u.feature
                : link?.allowed
                  ? link.missingFeature
                  : null;
            return (
              <Card key={u.id} className={unread ? 'border-primary/40' : undefined}>
                <CardHeader className="space-y-2 pb-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded px-2 py-0.5 ${CATEGORY_CLASS[u.category]}`}>
                      {PRODUCT_UPDATE_CATEGORY_LABELS[u.category]}
                    </span>
                    {unread && (
                      <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]">
                        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                        Sin leer
                      </Badge>
                    )}
                    <span className="text-muted-foreground">
                      {new Date(u.publishedAt).toLocaleDateString('es-ES', { dateStyle: 'long' })}
                    </span>
                  </div>
                  <CardTitle className="text-lg">{u.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {u.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={u.imageUrl} alt="" className="w-full max-w-2xl rounded-md border" />
                  )}
                  <MarkdownView content={u.body} />
                  <div className="flex flex-wrap items-center gap-3">
                    {missing ? (
                      <span className="text-xs text-muted-foreground">
                        {FEATURE_LABELS[missing]} no está en tu plan.
                        {canSeePlans && (
                          <>
                            {' '}
                            <Link href={PLANS_HREF} className="text-primary hover:underline">
                              Ver planes y extras
                            </Link>
                          </>
                        )}
                      </span>
                    ) : (
                      u.link &&
                      link?.allowed && (
                        <Button asChild size="sm" variant="outline">
                          <Link href={u.link}>
                            Ver
                            <ArrowRight className="ml-1 size-4" />
                          </Link>
                        </Button>
                      )
                    )}
                    {u.feature && u.featureIncluded === true && (
                      <span className="text-xs text-emerald-700 dark:text-emerald-400">
                        Incluido en tu plan
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {updates.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={updates.isFetchingNextPage}
                onClick={() => void updates.fetchNextPage()}
              >
                {updates.isFetchingNextPage && <Loader2 className="mr-2 size-4 animate-spin" />}
                Cargar más
              </Button>
            </div>
          )}
          {updates.isFetchNextPageError && (
            <p className="text-center text-sm text-muted-foreground">
              No se han podido cargar más novedades. Vuelve a intentarlo.
            </p>
          )}
        </>
      )}
    </div>
  );
}
