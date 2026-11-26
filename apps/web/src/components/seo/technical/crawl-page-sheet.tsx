'use client';

import { Loader2 } from 'lucide-react';

import { IssueRow } from './crawl-bits';
import { InspectUrlButton, SeoIndexStatusBadge } from './inspection-bits';

import { SectionError } from '@/components/dashboard/section-state';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ApiError } from '@/lib/auth/api';
import { formatCount, formatDateTime } from '@/lib/format';
import { type TechnicalScope, useCrawlPage } from '@/lib/seo-advanced/technical-hooks';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[150px_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function UrlList({
  urls,
  empty,
  onOpenUrl,
}: {
  urls: string[];
  empty: string;
  onOpenUrl: (url: string) => void;
}) {
  if (urls.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="max-h-60 space-y-1 overflow-y-auto text-sm">
      {urls.map((u) => (
        <li key={u}>
          <button
            type="button"
            onClick={() => onOpenUrl(u)}
            className="max-w-full break-all text-left hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {u}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Ficha de una URL del rastreo: sus datos, los enlaces que entran y salen y sus incidencias. */
export function CrawlPageSheet({
  scope,
  url,
  canEdit,
  onClose,
  onOpenUrl,
}: {
  scope: TechnicalScope;
  url: string | null;
  canEdit: boolean;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const q = useCrawlPage(scope, url);
  const p = q.data;
  return (
    <Sheet open={url !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-all pr-6">{url ?? ''}</SheetTitle>
          <SheetDescription>Lo que vio el rastreador en esta página.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          {q.isError ? (
            q.error instanceof ApiError && q.error.statusCode === 404 ? (
              <p className="text-sm text-muted-foreground">El último rastreo no tiene esta URL.</p>
            ) : (
              <SectionError onRetry={() => void q.refetch()} />
            )
          ) : q.isLoading || !p ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <dl className="space-y-2 text-sm">
                <Row label="Rastreada">{formatDateTime(p.crawledAt)}</Row>
                <Row label="Respuesta">
                  {p.robotsBlocked
                    ? `No se pidió: robots.txt lo impide (${p.robotsRule ?? '—'})`
                    : p.error
                      ? `No se pudo leer: ${p.error}`
                      : `${p.status ?? '—'}${p.responseMs !== null ? ` en ${formatCount(p.responseMs)} ms` : ''}`}
                </Row>
                {p.redirectChain.length > 0 && (
                  <Row label="Redirige a">{p.redirectChain.join(' → ')}</Row>
                )}
                <Row label="Título">{p.title ?? '—'}</Row>
                <Row label="Meta descripción">{p.description ?? '—'}</Row>
                <Row label="H1">{p.h1.length ? p.h1.join(' · ') : '—'}</Row>
                <Row label="Canónica">{p.canonical ?? 'No declara'}</Row>
                <Row label="Robots">
                  {[
                    p.noindex ? '«noindex»' : 'indexable',
                    p.nofollow ? '«nofollow»' : null,
                    p.googleBlocked ? 'robots.txt la bloquea para Google' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Row>
                {p.hreflang.length > 0 && (
                  <Row label="Idiomas">
                    {p.hreflang.map((h) => `${h.lang}: ${h.href}`).join(' · ')}
                  </Row>
                )}
                <Row label="Datos estructurados">
                  {p.jsonLdTypes.length ? p.jsonLdTypes.join(', ') : 'Ninguno'}
                </Row>
                <Row label="Imágenes">
                  {p.imagesTotal === 0
                    ? 'Ninguna'
                    : `${formatCount(p.imagesTotal)} (${formatCount(p.imagesWithoutAlt)} sin texto alternativo)`}
                </Row>
                <Row label="Profundidad">
                  {p.depth === null
                    ? 'No se llega desde la portada por enlaces'
                    : `${p.depth} clic${p.depth === 1 ? '' : 's'} desde la portada`}
                </Row>
                <Row label="Mapa del sitio">{p.inSitemap ? 'Sí' : 'No'}</Row>
                {p.impressions > 0 && (
                  <Row label="Impresiones (90 días)">{formatCount(p.impressions)}</Row>
                )}
                <Row label="Google">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <SeoIndexStatusBadge status={p.inspection} />
                    <InspectUrlButton scope={scope} url={p.url} canEdit={canEdit} />
                  </span>
                </Row>
              </dl>
              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">
                  Enlaces que llegan ({formatCount(p.linksIn.length)})
                </h3>
                <UrlList
                  urls={p.linksIn}
                  empty="Ninguna página de tu web la enlaza."
                  onOpenUrl={onOpenUrl}
                />
              </section>
              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">
                  Enlaces internos que salen ({formatCount(p.linksOut.length)})
                </h3>
                <UrlList urls={p.linksOut} empty="Ninguno." onOpenUrl={onOpenUrl} />
              </section>
              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">Incidencias</h3>
                {p.issuesList.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Ninguna.</p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {p.issuesList.map((i) => (
                      <IssueRow key={i.id} i={i} scope={scope} canEdit={canEdit} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
