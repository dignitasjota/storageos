'use client';

import { Check, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';

import type { TenantFollowupDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminFollowupsPending, useDeleteFollowup, useUpdateFollowup } from '@/lib/admin/hooks';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Etiqueta + color según el vencimiento del recordatorio. */
function dueMeta(due: string): { label: string; className: string } {
  const today = todayIso();
  if (due < today)
    return {
      label: `Vencido · ${due}`,
      className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    };
  if (due === today)
    return {
      label: 'Hoy',
      className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    };
  return { label: due, className: 'bg-muted text-muted-foreground' };
}

export default function AdminFollowupsPage() {
  const q = useAdminFollowupsPending();
  const update = useUpdateFollowup();
  const remove = useDeleteFollowup();

  if (q.isLoading || !q.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const items = q.data;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Seguimientos</h1>
        <p className="text-sm text-muted-foreground">
          Recordatorios pendientes con tenants, por fecha. Crea nuevos desde la ficha de cada
          tenant.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{items.length} pendiente(s)</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Nada pendiente. 🎉 Crea recordatorios desde la pestaña «Seguimientos» de un tenant.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((f) => (
                <FollowupRow
                  key={f.id}
                  f={f}
                  onDone={() => update.mutate({ followupId: f.id, status: 'done' })}
                  onDelete={() => {
                    if (window.confirm('¿Borrar este seguimiento?')) remove.mutate(f.id);
                  }}
                  busy={update.isPending || remove.isPending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FollowupRow({
  f,
  onDone,
  onDelete,
  busy,
}: {
  f: TenantFollowupDto;
  onDone: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const due = dueMeta(f.dueDate);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{f.title}</span>
          <Badge className={`border-0 ${due.className}`}>{due.label}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          <Link href={`/admin/tenants/${f.tenantId}`} className="hover:underline">
            {f.tenantName}
          </Link>
          {f.note ? ` · ${f.note}` : ''}
          {f.authorName ? ` · ${f.authorName}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={onDone} disabled={busy}>
          <Check className="mr-1 size-4" /> Hecho
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          disabled={busy}
          aria-label="Borrar seguimiento"
        >
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </div>
    </li>
  );
}
