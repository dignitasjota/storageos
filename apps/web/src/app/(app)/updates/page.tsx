'use client';

import {
  FEATURE_LABELS,
  PRODUCT_UPDATE_CATEGORY_LABELS,
  type ProductUpdateDto,
} from '@storageos/shared';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { MarkdownView } from '@/components/public/markdown-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMarkProductUpdatesSeen, useProductUpdates } from '@/lib/product-updates/hooks';

const CATEGORY_CLASS: Record<ProductUpdateDto['category'], string> = {
  new: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  improvement: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  fix: 'bg-muted text-muted-foreground',
};

export default function ProductUpdatesPage() {
  const updates = useProductUpdates();
  const markSeen = useMarkProductUpdatesSeen();
  const marked = useRef(false);

  // Al abrir la página se dan por vistas (la marca de «Nuevo» se mantiene en
  // esta visita porque la lista ya está cargada).
  useEffect(() => {
    if (updates.isSuccess && !marked.current) {
      marked.current = true;
      markSeen.mutate();
    }
  }, [updates.isSuccess, markSeen]);

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
      ) : !updates.data || updates.data.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Todavía no hay novedades publicadas.
          </CardContent>
        </Card>
      ) : (
        updates.data.map((u) => (
          <Card key={u.id} className={u.unread ? 'border-primary/40' : undefined}>
            <CardHeader className="space-y-2 pb-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded px-2 py-0.5 ${CATEGORY_CLASS[u.category]}`}>
                  {PRODUCT_UPDATE_CATEGORY_LABELS[u.category]}
                </span>
                {u.unread && <Badge className="h-5 px-1.5 text-[10px]">Nuevo</Badge>}
                <span className="text-muted-foreground">
                  {new Date(u.publishedAt).toLocaleDateString('es-ES', { dateStyle: 'long' })}
                </span>
              </div>
              <CardTitle className="text-lg">{u.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <MarkdownView content={u.body} />
              <div className="flex flex-wrap items-center gap-3">
                {u.link && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={u.link}>
                      Ver
                      <ArrowRight className="ml-1 size-4" />
                    </Link>
                  </Button>
                )}
                {u.feature && u.featureIncluded === false && (
                  <span className="text-xs text-muted-foreground">
                    {FEATURE_LABELS[u.feature]} no está en tu plan.{' '}
                    <Link href="/settings/saas-billing" className="text-primary hover:underline">
                      Ver planes y extras
                    </Link>
                  </span>
                )}
                {u.feature && u.featureIncluded === true && (
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">
                    Incluido en tu plan
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
