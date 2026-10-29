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
  const active = (admins.data ?? []).filter((a) => a.isActive);

  function postpone(days: number) {
    update.mutate(
      { followupId: f.id, dueDate: plusDays(days) },
      { onSuccess: () => toast.success(`Pospuesto al ${plusDays(days)}.`) },
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
        onChange={(e) => update.mutate({ followupId: f.id, assignedToId: e.target.value || null })}
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
