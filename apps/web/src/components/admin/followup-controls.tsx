'use client';

import { CalendarPlus } from 'lucide-react';
import { toast } from 'sonner';

import type { PlatformLeadFollowupDto, TenantFollowupDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAdminSuperAdmins, useUpdateFollowup } from '@/lib/admin/hooks';
import { useUpdateLeadFollowup } from '@/lib/admin/leads-hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';
import { formatShortDay } from '@/lib/format';

/** Fecha de hoy + N días (YYYY-MM-DD). */
function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

const onError = (err: unknown) =>
  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');

/** Menú «Posponer» (1/3/7/14/30 días) y selector de quién se encarga. */
function FollowupControlsView({
  assignedToId,
  allowSales,
  busy,
  onPostpone,
  onAssign,
}: {
  assignedToId: string | null;
  /** Los seguimientos de leads sí los pueden llevar los comerciales. */
  allowSales: boolean;
  busy: boolean;
  onPostpone: (day: string) => void;
  onAssign: (id: string | null) => void;
}) {
  const admins = useAdminSuperAdmins();
  const active = (admins.data ?? []).filter(
    (a) => a.isActive && (allowSales || a.role !== 'sales'),
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Posponer"
            title="Posponer"
            disabled={busy}
          >
            <CalendarPlus className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {[1, 3, 7, 14, 30].map((d) => (
            <DropdownMenuItem key={d} onSelect={() => onPostpone(plusDays(d))}>
              {d === 1 ? 'A mañana' : `${d} días`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <select
        value={assignedToId ?? ''}
        onChange={(e) => onAssign(e.target.value || null)}
        aria-label="Quién se encarga"
        disabled={busy}
        className="h-8 max-w-[140px] rounded-md border bg-background px-1 text-xs"
      >
        <option value="">Sin asignar</option>
        {active.map((a) => (
          <option key={a.id} value={a.id}>
            {a.fullName}
          </option>
        ))}
      </select>
    </>
  );
}

/** Posponer un seguimiento y cambiar quién se encarga (bandeja y ficha del tenant). */
export function FollowupControls({ f }: { f: TenantFollowupDto }) {
  const update = useUpdateFollowup();
  return (
    <FollowupControlsView
      assignedToId={f.assignedToId}
      // Los comerciales no llevan los seguimientos de soporte.
      allowSales={false}
      busy={update.isPending}
      onPostpone={(day) =>
        update.mutate(
          { followupId: f.id, dueDate: day },
          { onSuccess: () => toast.success(`Pospuesto al ${formatShortDay(day)}.`), onError },
        )
      }
      onAssign={(id) => update.mutate({ followupId: f.id, assignedToId: id }, { onError })}
    />
  );
}

/** Lo mismo para los seguimientos de leads (bandeja de Seguimientos). */
export function LeadFollowupControls({ f }: { f: PlatformLeadFollowupDto }) {
  const update = useUpdateLeadFollowup();
  return (
    <FollowupControlsView
      assignedToId={f.assignedToId}
      allowSales
      busy={update.isPending}
      onPostpone={(day) =>
        update.mutate(
          { id: f.id, input: { dueDate: day } },
          { onSuccess: () => toast.success(`Pospuesto al ${formatShortDay(day)}.`), onError },
        )
      }
      onAssign={(id) => update.mutate({ id: f.id, input: { assignedToId: id } }, { onError })}
    />
  );
}
