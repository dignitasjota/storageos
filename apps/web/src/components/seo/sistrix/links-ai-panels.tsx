'use client';

import { Loader2 } from 'lucide-react';

import { SeoOrigin } from './seo-origin';

import { SectionError } from '@/components/dashboard/section-state';
import { formatCount } from '@/lib/format';
import { type SistrixScope, useSistrixBacklinks } from '@/lib/seo-advanced/sistrix-hooks';

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
