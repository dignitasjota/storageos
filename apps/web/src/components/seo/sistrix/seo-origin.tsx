'use client';

import { SEO_PROVIDER_LABELS, type SeoDataOriginDto } from '@storageos/shared';

import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Origen de un dato y su fecha: «SISTRIX (MCP) · 23/11/2026». */
export function SeoOrigin({
  origin,
  className,
}: {
  origin: Pick<SeoDataOriginDto, 'provider' | 'fetchedAt'> & { dataDate?: string | null };
  className?: string;
}) {
  const date = origin.dataDate ?? origin.fetchedAt;
  return (
    <span
      className={cn('text-xs text-muted-foreground', className)}
      title={`Obtenido el ${formatDateTime(origin.fetchedAt)}`}
    >
      {SEO_PROVIDER_LABELS[origin.provider]} · {formatDate(date)}
    </span>
  );
}
