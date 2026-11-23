'use client';

import { CalendarPlus } from 'lucide-react';
import { toast } from 'sonner';

import type { TenantFollowupDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAdminSuperAdmins, useUpdateFollowup } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';

/** Fecha de hoy + N días (YYYY-MM-DD). */
function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateString(d);
}

/** Posponer un seguimiento y cambiar quién se encarga (bandeja y ficha del tenant). */
export function FollowupControls({ f }: { f: TenantFollowupDto }) {
  const update = useUpdateFollowup();
  const admins = useAdminSuperAdmins();
  // Los comerciales no llevan los seguimientos de soporte.
  const active = (admins.data ?? []).filter((a) => a.isActive && a.role !== 'sales');
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');

  function postpone(days: number) {
    const day = plusDays(days);
    update.mutate(
      { followupId: f.id, dueDate: day },
      {
        onSuccess: () => toast.success(`Pospuesto al ${day.split('-').reverse().join('/')}.`),
        onError,
      },
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Posponer" title="Posponer">
            <CalendarPlus className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {[1, 3, 7, 14, 30].map((d) => (
            <DropdownMenuItem key={d} onSelect={() => postpone(d)}>
              {d === 1 ? 'A mañana' : `${d} días`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <select
        value={f.assignedToId ?? ''}
        onChange={(e) =>
          update.mutate({ followupId: f.id, assignedToId: e.target.value || null }, { onError })
        }
        aria-label="Quién se encarga"
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
