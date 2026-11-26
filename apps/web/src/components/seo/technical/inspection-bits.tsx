'use client';

import {
  SEO_CRAWLED_AS_LABELS,
  SEO_INDEXING_STATE_LABELS,
  SEO_INSPECTION_REASON_LABELS,
  SEO_INSPECTION_VERDICT_LABELS,
  SEO_PAGE_FETCH_LABELS,
  SEO_ROBOTS_STATE_LABELS,
  type SeoUrlIndexStatusDto,
  type SeoUrlInspectionDto,
} from '@storageos/shared';
import { ExternalLink, Loader2, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format';
import { type TechnicalScope, useInspectUrl } from '@/lib/seo-advanced/technical-hooks';
import { cn } from '@/lib/utils';

const GOOD =
  'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
const BAD = 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
const WARN = 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';

/**
 * Lo que dice Google de una URL según su última inspección: «Indexación
 * confirmada (fecha)» o «Google dice que no está indexada (motivo)», y si
 * Google eligió otra canónica. Sin inspección, lo dice.
 */
export function SeoIndexStatusBadge({
  status,
  className,
}: {
  status: SeoUrlIndexStatusDto | null | undefined;
  className?: string;
}) {
  if (!status) {
    return (
      <Badge variant="outline" className={cn('font-normal text-muted-foreground', className)}>
        Sin inspeccionar con Google
      </Badge>
    );
  }
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      <Badge
        variant="outline"
        className={cn(
          'max-w-full whitespace-normal font-normal',
          status.indexed === true ? GOOD : status.indexed === false ? BAD : '',
        )}
        title={status.stale ? 'Inspección de hace más de 30 días: puede haber cambiado' : undefined}
      >
        {status.label}
        {status.stale && ' · antigua'}
      </Badge>
      {status.canonicalMismatch && (
        <Badge variant="outline" className={cn('font-normal', WARN)}>
          Canónica distinta
        </Badge>
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const label = (map: Record<string, string>, v: string | null) => (v ? (map[v] ?? v) : '—');

/** El detalle de una inspección (lo que devolvió Google), en palabras. */
export function InspectionDetail({ i }: { i: SeoUrlInspectionDto }) {
  if (i.status !== 'done') {
    return (
      <p className="text-sm text-muted-foreground">
        {i.status === 'error'
          ? `Google no pudo inspeccionarla: ${i.error ?? 'error desconocido'}`
          : i.scheduledFor && Date.parse(i.scheduledFor) > Date.now()
            ? `Espera a que se reinicie la cuota de Google: se hará el ${formatDateTime(i.scheduledFor)}.`
            : 'En la cola: se hará en unos minutos.'}
      </p>
    );
  }
  return (
    <dl className="space-y-2 text-sm">
      <Row label="Veredicto">
        <span className="font-medium">
          {i.indexed === true
            ? 'Está en el índice de Google'
            : i.indexed === false
              ? `No está en el índice: ${i.notIndexedReason ?? '—'}`
              : 'Google no da veredicto'}
        </span>{' '}
        <span className="text-muted-foreground">
          ({label(SEO_INSPECTION_VERDICT_LABELS, i.verdict)})
        </span>
      </Row>
      <Row label="Lo que dice Google">{i.coverageState ?? '—'}</Row>
      <Row label="robots.txt">{label(SEO_ROBOTS_STATE_LABELS, i.robotsTxtState)}</Row>
      <Row label="Indexación">{label(SEO_INDEXING_STATE_LABELS, i.indexingState)}</Row>
      <Row label="Lectura de la página">{label(SEO_PAGE_FETCH_LABELS, i.pageFetchState)}</Row>
      <Row label="Último rastreo">
        {i.lastCrawlAt ? formatDateTime(i.lastCrawlAt) : '—'} ·{' '}
        {label(SEO_CRAWLED_AS_LABELS, i.crawledAs)}
      </Row>
      <Row label="Canónica de Google">
        <span className="break-all">{i.googleCanonical ?? '—'}</span>
      </Row>
      <Row label="Canónica declarada">
        <span className="break-all">{i.userCanonical ?? 'Ninguna'}</span>
        {i.canonicalMismatch && (
          <Badge variant="outline" className={cn('ml-1 font-normal', WARN)}>
            Distinta
          </Badge>
        )}
      </Row>
      {i.sitemaps.length > 0 && (
        <Row label="En los sitemaps">
          <span className="break-all">{i.sitemaps.join(', ')}</span>
        </Row>
      )}
      {i.referringUrls.length > 0 && (
        <Row label="Enlazada desde">
          <span className="break-all">{i.referringUrls.slice(0, 5).join(', ')}</span>
        </Row>
      )}
      {i.mobileUsability && (
        <Row label="Uso en móvil">
          {i.mobileUsability.issues.length ? i.mobileUsability.issues.join(' · ') : 'Sin problemas'}
        </Row>
      )}
      {i.richResults && (
        <Row label="Resultados enriquecidos">
          {i.richResults.types.join(', ') || '—'}
          {i.richResults.issues.length > 0 && ` · avisos: ${i.richResults.issues.join(' · ')}`}
        </Row>
      )}
      <Row label="Inspeccionada">
        {i.inspectedAt ? formatDateTime(i.inspectedAt) : '—'} ·{' '}
        {SEO_INSPECTION_REASON_LABELS[i.reason]}
      </Row>
      {i.link && (
        <a
          href={i.link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Abrir en Search Console <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
      <p className="text-xs text-muted-foreground">
        Origen: inspección de URL de Google (Search Console), consultada el{' '}
        {i.inspectedAt ? formatDateTime(i.inspectedAt) : '—'}.
      </p>
    </dl>
  );
}

/**
 * Botón «Inspeccionar en Google» de una URL (gasta una consulta de la cuota
 * del día). Enseña el resultado en un diálogo; sin cuota, avisa de que espera.
 */
export function InspectUrlButton({
  scope,
  url,
  canEdit,
  label: text = 'Inspeccionar en Google',
  size = 'sm',
  variant = 'outline',
}: {
  scope: TechnicalScope;
  url: string;
  canEdit: boolean;
  label?: string;
  size?: 'sm' | 'icon';
  variant?: 'outline' | 'ghost';
}) {
  const inspect = useInspectUrl(scope);
  const [result, setResult] = useState<SeoUrlInspectionDto | null>(null);
  if (!canEdit) return null;
  const run = async () => {
    try {
      const r = await inspect.mutateAsync(url);
      if (r.deferred) toast.info(r.message);
      else if (r.inspection.status === 'error') toast.error(r.message);
      setResult(r.inspection);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => void run()}
        disabled={inspect.isPending}
        aria-label={size === 'icon' ? `${text}: ${url}` : undefined}
        title={size === 'icon' ? text : undefined}
      >
        {inspect.isPending ? (
          <Loader2 className={cn('size-4 animate-spin', size !== 'icon' && 'mr-1')} aria-hidden />
        ) : (
          <ScanSearch className={cn('size-4', size !== 'icon' && 'mr-1')} aria-hidden />
        )}
        {size !== 'icon' && text}
      </Button>
      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="break-all pr-6">{result?.url}</DialogTitle>
            <DialogDescription>Lo que dice Google de esta URL</DialogDescription>
          </DialogHeader>
          {result && <InspectionDetail i={result} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
