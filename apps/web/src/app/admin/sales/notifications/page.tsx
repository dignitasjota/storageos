'use client';

import { SUPER_ADMIN_PUSH_TYPES } from '@storageos/shared';
import { CheckCheck, Loader2 } from 'lucide-react';
import Link from 'next/link';

import { Empty, PageHeader, QueryError, SalesPage } from '@/components/admin/sales/common';
import { DevicePushCard } from '@/components/push/device-push-card';
import { Button } from '@/components/ui/button';
import { adminApiFetch } from '@/lib/admin/api';
import {
  useSalesMarkRead,
  useSalesNotifications,
  useSalesUnreadCount,
} from '@/lib/admin/sales-hooks';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Avisos que le llegan al comercial (los de su cartera). */
const SALES_TOPICS = Object.entries(SUPER_ADMIN_PUSH_TYPES)
  .filter(
    ([k]) => k.startsWith('sales.') && k !== 'sales.addon_claim' && k !== 'sales.concept_request',
  )
  .map(([, v]) => v);

export default function SalesNotificationsPage() {
  const list = useSalesNotifications();
  const count = useSalesUnreadCount().data?.count ?? 0;
  const mark = useSalesMarkRead();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <SalesPage>
      <PageHeader
        title="Avisos"
        description={count > 0 ? `${count} sin leer` : 'Todo leído'}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={count === 0 || mark.isPending}
            onClick={() => mark.mutate(null)}
          >
            <CheckCheck className="mr-1.5 size-4" /> Marcar todo leído
          </Button>
        }
      />
      <DevicePushCard fetcher={adminApiFetch} basePath="/admin/me/push" topics={SALES_TOPICS} />
      {list.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : list.isError ? (
        <QueryError query={list} />
      ) : items.length === 0 ? (
        <Empty>No tienes avisos.</Empty>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((n) => {
            const body = (
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm', !n.readAt && 'font-semibold')}>{n.title}</p>
                {n.body && <p className="text-sm text-muted-foreground">{n.body}</p>}
                <p className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</p>
              </div>
            );
            return (
              <li
                key={n.id}
                className={cn('flex items-start gap-3 px-3 py-2.5', !n.readAt && 'bg-primary/5')}
              >
                {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-500" />}
                {n.link ? (
                  <Link
                    href={n.link}
                    className="min-w-0 flex-1 hover:underline"
                    onClick={() => !n.readAt && mark.mutate(n.id)}
                  >
                    {body}
                  </Link>
                ) : (
                  body
                )}
                {!n.readAt && (
                  <Button size="sm" variant="ghost" onClick={() => mark.mutate(n.id)}>
                    Leído
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}
    </SalesPage>
  );
}
