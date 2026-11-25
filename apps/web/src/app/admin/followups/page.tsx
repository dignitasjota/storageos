'use client';

import {
  ADMIN_FOLLOWUPS_LIST_LIMIT,
  PLATFORM_LEAD_FOLLOWUPS_LIST_LIMIT,
  type PlatformLeadFollowupDto,
  type TenantFollowupDto,
} from '@storageos/shared';
import { Check, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { FollowupControls, LeadFollowupControls } from '@/components/admin/followup-controls';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminFollowupsPending, useDeleteFollowup, useUpdateFollowup } from '@/lib/admin/hooks';
import {
  useAdminLeadFollowups,
  useDeleteLeadFollowup,
  useUpdateLeadFollowup,
} from '@/lib/admin/leads-hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';
import { formatShortDay, plural } from '@/lib/format';

const onError = (err: unknown) =>
  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');

/** Etiqueta + color según el vencimiento del recordatorio. */
function dueMeta(due: string): { label: string; className: string } {
  const today = localDateString();
  if (due < today)
    return {
      label: `Vencido · ${formatShortDay(due)}`,
      className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    };
  if (due === today)
    return {
      label: 'Hoy',
      className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    };
  return { label: formatShortDay(due), className: 'bg-muted text-muted-foreground' };
}

/** Aviso cuando la lista llega a su tope (los más antiguos salen primero). */
function LimitNotice({ shown, limit }: { shown: number; limit: number }) {
  if (shown < limit) return null;
  return (
    <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
      Se muestran los {limit} primeros por fecha. Cierra o pospón los vencidos para ver el resto.
    </p>
  );
}

export default function AdminFollowupsPage() {
  const confirm = useConfirm();
  const [mine, setMine] = useState(false);
  const q = useAdminFollowupsPending(mine);
  const update = useUpdateFollowup();
  const remove = useDeleteFollowup();

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Seguimientos</h1>
          <p className="text-sm text-muted-foreground">
            Recordatorios pendientes con tenants y con leads, por fecha. Se crean desde la ficha de
            cada tenant o de cada lead.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Solo los míos
        </label>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Tenants
            {q.data ? `: ${plural(q.data.length, 'pendiente', 'pendientes')}` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {q.isError ? (
            <AdminError onRetry={() => void q.refetch()} />
          ) : q.isLoading || !q.data ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : q.data.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Nada pendiente. 🎉 Crea recordatorios desde la pestaña «Seguimientos» de un tenant.
            </p>
          ) : (
            <>
              <LimitNotice shown={q.data.length} limit={ADMIN_FOLLOWUPS_LIST_LIMIT} />
              <ul className="divide-y">
                {q.data.map((f) => (
                  <FollowupRow
                    key={f.id}
                    f={f}
                    onDone={() =>
                      update.mutate(
                        { followupId: f.id, status: 'done' },
                        { onSuccess: () => toast.success('Seguimiento hecho.'), onError },
                      )
                    }
                    onDelete={async () => {
                      if (await confirm({ title: '¿Borrar este seguimiento?', destructive: true }))
                        remove.mutate(f.id, { onError });
                    }}
                    busy={update.isPending || remove.isPending}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <LeadFollowupsCard mine={mine} />
    </div>
  );
}

/** Seguimientos de leads (quien aún no es tenant o acaba de serlo). */
function LeadFollowupsCard({ mine }: { mine: boolean }) {
  const confirm = useConfirm();
  const q = useAdminLeadFollowups(mine);
  const update = useUpdateLeadFollowup();
  const remove = useDeleteLeadFollowup();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Leads{q.data ? `: ${plural(q.data.length, 'pendiente', 'pendientes')}` : ''}
        </CardTitle>
        {!mine && (
          <p className="text-xs text-muted-foreground">
            Los de los prospectos de los comerciales no salen aquí: están en Carteras.
          </p>
        )}
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <AdminError onRetry={() => void q.refetch()} />
        ) : q.isLoading || !q.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.data.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nada pendiente con los leads. Se crean desde la ficha de cada lead.
          </p>
        ) : (
          <>
            <LimitNotice shown={q.data.length} limit={PLATFORM_LEAD_FOLLOWUPS_LIST_LIMIT} />
            <ul className="divide-y">
              {q.data.map((f) => (
                <LeadFollowupRow
                  key={f.id}
                  f={f}
                  busy={update.isPending || remove.isPending}
                  onDone={() =>
                    update.mutate(
                      { id: f.id, input: { status: 'done' } },
                      { onSuccess: () => toast.success('Seguimiento hecho.'), onError },
                    )
                  }
                  onDelete={async () => {
                    if (await confirm({ title: '¿Borrar este seguimiento?', destructive: true }))
                      remove.mutate(f.id, { onError });
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Fila de la bandeja: el texto ocupa todo el ancho y, en el móvil, las
 * acciones van debajo (el título no se parte palabra a palabra).
 */
function RowShell({
  title,
  dueDate,
  subtitle,
  actions,
}: {
  title: string;
  dueDate: string;
  subtitle: ReactNode;
  actions: ReactNode;
}) {
  const due = dueMeta(dueDate);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words font-medium">{title}</span>
          <Badge className={`shrink-0 border-0 ${due.className}`}>{due.label}</Badge>
        </div>
        <div className="break-words text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">{actions}</div>
    </li>
  );
}

function DoneAndDelete({
  onDone,
  onDelete,
  busy,
}: {
  onDone: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <>
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
    </>
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
  return (
    <RowShell
      title={f.title}
      dueDate={f.dueDate}
      subtitle={
        <>
          <Link href={`/admin/tenants/${f.tenantId}`} className="hover:underline">
            {f.tenantName}
          </Link>
          {f.note ? ` · ${f.note}` : ''}
          {f.assignedToName ? ` · se encarga ${f.assignedToName}` : ''}
        </>
      }
      actions={
        <>
          <FollowupControls f={f} />
          <DoneAndDelete onDone={onDone} onDelete={onDelete} busy={busy} />
        </>
      }
    />
  );
}

function LeadFollowupRow({
  f,
  onDone,
  onDelete,
  busy,
}: {
  f: PlatformLeadFollowupDto;
  onDone: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <RowShell
      title={f.title}
      dueDate={f.dueDate}
      subtitle={
        <>
          <Link href={`/admin/leads?lead=${f.leadId}`} className="hover:underline">
            {f.leadName}
          </Link>
          {f.note ? ` · ${f.note}` : ''}
          {f.assignedToName ? ` · se encarga ${f.assignedToName}` : ''}
        </>
      }
      actions={
        <>
          <LeadFollowupControls f={f} />
          <DoneAndDelete onDone={onDone} onDelete={onDelete} busy={busy} />
        </>
      }
    />
  );
}
