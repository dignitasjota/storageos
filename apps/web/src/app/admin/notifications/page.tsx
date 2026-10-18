'use client';

import { BellRing, CheckCheck, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import type { SuperAdminNotificationDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  useAdminNotificationsPage,
  useAdminNotifUnreadCount,
  useMarkNotifRead,
  useMarkNotifsRead,
} from '@/lib/admin/hooks';
import { cn } from '@/lib/utils';

/** Día legible para agrupar: «Hoy», «Ayer» o la fecha. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Avisos de la plataforma para el super admin (tickets, correos rechazados…). */
export default function AdminNotificationsPage() {
  const [unread, setUnread] = useState(false);
  const page = useAdminNotificationsPage(unread);
  const count = useAdminNotifUnreadCount().data?.count ?? 0;
  const markAll = useMarkNotifsRead();
  const markOne = useMarkNotifRead();

  if (page.isError) return <AdminError onRetry={() => void page.refetch()} />;

  const items = page.data?.pages.flatMap((p) => p.items) ?? [];
  const groups: { label: string; items: SuperAdminNotificationDto[] }[] = [];
  for (const n of items) {
    const label = dayLabel(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notificaciones</h1>
          <p className="text-sm text-muted-foreground">
            {count > 0 ? `${count} sin leer` : 'Todo leído'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5 text-sm">
            {[
              { v: false, label: 'Todas' },
              { v: true, label: 'Sin leer' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => setUnread(o.v)}
                className={cn(
                  'rounded px-3 py-1',
                  unread === o.v ? 'bg-accent font-medium' : 'text-muted-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAll.mutate()}
            disabled={count === 0 || markAll.isPending}
          >
            <CheckCheck className="mr-1.5 size-4" /> Marcar todas leídas
          </Button>
        </div>
      </div>

      {page.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {unread ? 'No tienes notificaciones sin leer.' : 'Aún no hay notificaciones.'}
          </CardContent>
        </Card>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground first-letter:uppercase">
              {g.label}
            </h2>
            <Card>
              <CardContent className="divide-y p-0">
                {g.items.map((n) => {
                  const body = (
                    <div className="flex items-start gap-3 px-4 py-3">
                      <span
                        className={cn(
                          'mt-1.5 size-2 shrink-0 rounded-full',
                          n.readAt ? 'bg-transparent' : 'bg-blue-500',
                        )}
                        aria-label={n.readAt ? undefined : 'Sin leer'}
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-sm', !n.readAt && 'font-medium')}>{n.title}</p>
                        {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(n.createdAt).toLocaleTimeString('es-ES', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  );
                  const onOpen = () => {
                    if (!n.readAt) markOne.mutate(n.id);
                  };
                  return n.link && n.link.startsWith('/') ? (
                    <Link
                      key={n.id}
                      href={n.link}
                      onClick={onOpen}
                      className="block hover:bg-accent/40"
                    >
                      {body}
                    </Link>
                  ) : (
                    <button
                      key={n.id}
                      type="button"
                      onClick={onOpen}
                      className="block w-full text-left hover:bg-accent/40"
                    >
                      {body}
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          </section>
        ))
      )}

      {page.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void page.fetchNextPage()}
            disabled={page.isFetchingNextPage}
          >
            {page.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BellRing className="size-3.5" /> Avisos de tickets nuevos, correos rechazados, facturas de
        suscripción con datos incompletos y extras cancelados.
      </p>
    </div>
  );
}
