'use client';

import { Bell, Check, CheckCheck } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/lib/notifications/hooks';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NotificationsPage() {
  const { data, isLoading } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notificaciones</h1>
          <p className="text-sm text-muted-foreground">
            Avisos del negocio: pagos, vencimientos, incidencias, solicitudes…
          </p>
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={() => markAll.mutate()}>
            <CheckCheck className="mr-1 size-4" /> Marcar todas leídas
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <Bell className="size-6" />
              <p className="text-sm">No tienes notificaciones.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const body = (
                  <div className="flex items-start gap-3 px-3 py-3">
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-blue-500'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${n.readAt ? '' : 'font-medium'}`}>{n.title}</p>
                      {n.body && <p className="truncate text-xs text-muted-foreground">{n.body}</p>}
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{fmt(n.createdAt)}</p>
                    </div>
                    {!n.readAt && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                        title="Marcar leída"
                        onClick={(e) => {
                          e.preventDefault();
                          markRead.mutate(n.id);
                        }}
                        aria-label="Marcar como hecho"
                      >
                        <Check className="size-4" />
                      </Button>
                    )}
                  </div>
                );
                return (
                  <li key={n.id} className={n.readAt ? '' : 'bg-muted/30'}>
                    {n.link ? (
                      <Link
                        href={n.link}
                        onClick={() => !n.readAt && markRead.mutate(n.id)}
                        className="block hover:bg-muted"
                      >
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
