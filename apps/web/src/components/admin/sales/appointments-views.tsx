'use client';

import { type SalesAppointmentDto } from '@storageos/shared';
import { CalendarPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  AppointmentDialog,
  type AppointmentFormValues,
  AppointmentList,
  createFromForm,
  updateFromForm,
} from '@/components/admin/sales/appointments';
import { QueryState } from '@/components/admin/sales/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type AppointmentScope,
  useCreateMyAppointment,
  useCreateTeamAppointment,
  useDeleteMyAppointment,
  useDeleteTeamAppointment,
  useMyAppointments,
  useTeamAppointments,
  useUpdateMyAppointment,
  useUpdateTeamAppointment,
} from '@/lib/admin/appointments-hooks';

/** Al editar una cita cerrada con otra fecha, vuelve a quedar pendiente. */
function editInput(editing: SalesAppointmentDto, v: AppointmentFormValues) {
  return {
    ...updateFromForm(v),
    ...(editing.status !== 'scheduled' ? { status: 'scheduled' as const } : {}),
  };
}

function ScopeTabs({
  value,
  onChange,
}: {
  value: AppointmentScope;
  onChange: (v: AppointmentScope) => void;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5 text-xs">
      {(
        [
          ['upcoming', 'Próximas'],
          ['past', 'Pasadas'],
        ] as const
      ).map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={
            value === k
              ? 'rounded bg-primary px-2.5 py-1 text-primary-foreground'
              : 'rounded px-2.5 py-1 text-muted-foreground hover:text-foreground'
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- comercial

/** Citas de una cuenta en la ficha del comercial. */
export function AccountAppointmentsCard({ leadId }: { leadId: string }) {
  const list = useMyAppointments({ leadId, scope: 'all' });
  const create = useCreateMyAppointment(leadId);
  const update = useUpdateMyAppointment();
  const remove = useDeleteMyAppointment();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SalesAppointmentDto | null>(null);
  const items = list.data ?? [];
  const upcoming = items
    .filter((a) => a.status === 'scheduled')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = items.filter((a) => a.status !== 'scheduled').slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Citas</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <CalendarPlus className="mr-1 size-4" aria-hidden />
          Nueva cita
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {!list.data && <QueryState query={list} />}
        {list.data && (
          <AppointmentList
            items={upcoming}
            empty="Sin citas pendientes. Pon una llamada, videollamada o visita con fecha y hora."
            onUpdate={(id, input) => update.mutateAsync({ id, input })}
            onDelete={(id) => remove.mutateAsync(id)}
            onEdit={setEditing}
          />
        )}
        {past.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Anteriores ({past.length})
            </summary>
            <AppointmentList
              items={past}
              onUpdate={(id, input) => update.mutateAsync({ id, input })}
              onDelete={(id) => remove.mutateAsync(id)}
              onEdit={setEditing}
            />
          </details>
        )}
      </CardContent>
      <AppointmentDialog
        open={open || !!editing}
        initial={editing}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        onSubmit={async (v) => {
          if (editing) {
            await update.mutateAsync({ id: editing.id, input: editInput(editing, v) });
            toast.success('Cita cambiada.');
          } else {
            await create.mutateAsync(createFromForm(v));
            toast.success('Cita puesta. Te avisaremos el día antes y una hora antes.');
          }
        }}
      />
    </Card>
  );
}

/** «Mis citas»: todas las del comercial. */
export function MyAppointmentsList() {
  const [scope, setScope] = useState<AppointmentScope>('upcoming');
  const list = useMyAppointments({ scope });
  const update = useUpdateMyAppointment();
  const remove = useDeleteMyAppointment();
  const [editing, setEditing] = useState<SalesAppointmentDto | null>(null);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">{scope === 'upcoming' ? 'Próximas' : 'Pasadas'}</CardTitle>
        <ScopeTabs value={scope} onChange={setScope} />
      </CardHeader>
      <CardContent>
        {!list.data && <QueryState query={list} />}
        {list.data && (
          <AppointmentList
            items={list.data}
            leadHref={(a) => `/admin/sales/accounts/${a.leadId}`}
            empty={
              scope === 'upcoming'
                ? 'No tienes citas pendientes. Ponlas desde la ficha de cada cliente.'
                : 'Aún no hay citas pasadas.'
            }
            onUpdate={(id, input) => update.mutateAsync({ id, input })}
            onDelete={(id) => remove.mutateAsync(id)}
            onEdit={setEditing}
          />
        )}
      </CardContent>
      <AppointmentDialog
        open={!!editing}
        initial={editing}
        onClose={() => setEditing(null)}
        onSubmit={async (v) => {
          if (!editing) return;
          await update.mutateAsync({ id: editing.id, input: editInput(editing, v) });
          toast.success('Cita cambiada.');
        }}
      />
    </Card>
  );
}

// ------------------------------------------------------------- dirección

/** Citas de un lead en su ficha del panel admin (la dirección se las pone a un comercial). */
export function LeadAppointmentsPanel({
  leadId,
  reps,
  defaultRepId,
}: {
  leadId: string;
  reps: { id: string; fullName: string }[];
  defaultRepId: string | null;
}) {
  const list = useTeamAppointments({ leadId, scope: 'all' });
  const create = useCreateTeamAppointment();
  const update = useUpdateTeamAppointment();
  const remove = useDeleteTeamAppointment();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SalesAppointmentDto | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Al comercial le llega un aviso al ponérsela, el día antes y una hora antes.
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!reps.length}>
          <CalendarPlus className="mr-1 size-4" aria-hidden />
          Nueva cita
        </Button>
      </div>
      {!reps.length && (
        <p className="text-xs text-muted-foreground">
          No hay comerciales activos a los que ponerle la cita.
        </p>
      )}
      {!list.data && <QueryState query={list} />}
      {list.data && (
        <AppointmentList
          items={list.data}
          showRep
          empty="Este lead no tiene citas."
          onUpdate={(id, input) => update.mutateAsync({ id, input })}
          onDelete={(id) => remove.mutateAsync(id)}
          onEdit={setEditing}
        />
      )}
      <AppointmentDialog
        open={open || !!editing}
        initial={editing}
        reps={editing ? undefined : reps}
        defaultRepId={defaultRepId}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        onSubmit={async (v) => {
          if (editing) {
            await update.mutateAsync({ id: editing.id, input: editInput(editing, v) });
            toast.success('Cita cambiada. Se le ha avisado al comercial.');
          } else {
            await create.mutateAsync({
              ...createFromForm(v),
              leadId,
              ...(v.repId ? { repId: v.repId } : {}),
            });
            toast.success('Cita puesta. Se le ha avisado al comercial.');
          }
        }}
      />
    </div>
  );
}

/** Citas de todo el equipo, con filtro por comercial. */
export function TeamAppointmentsList({ reps }: { reps: { id: string; fullName: string }[] }) {
  const [scope, setScope] = useState<AppointmentScope>('upcoming');
  const [repId, setRepId] = useState('');
  const list = useTeamAppointments({ scope, ...(repId ? { repId } : {}) });
  const update = useUpdateTeamAppointment();
  const remove = useDeleteTeamAppointment();
  const [editing, setEditing] = useState<SalesAppointmentDto | null>(null);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">
            {scope === 'upcoming' ? 'Próximas' : 'Pasadas'}
          </CardTitle>
          <select
            aria-label="Comercial"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={repId}
            onChange={(e) => setRepId(e.target.value)}
          >
            <option value="">Todos los comerciales</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
        <ScopeTabs value={scope} onChange={setScope} />
      </CardHeader>
      <CardContent>
        {!list.data && <QueryState query={list} />}
        {list.data && (
          <AppointmentList
            items={list.data}
            showRep
            leadHref={(a) => `/admin/leads?lead=${a.leadId}`}
            empty={
              scope === 'upcoming'
                ? 'No hay citas pendientes. Pónselas desde la ficha de cada lead (pestaña «Citas»).'
                : 'Aún no hay citas pasadas.'
            }
            onUpdate={(id, input) => update.mutateAsync({ id, input })}
            onDelete={(id) => remove.mutateAsync(id)}
            onEdit={setEditing}
          />
        )}
      </CardContent>
      <AppointmentDialog
        open={!!editing}
        initial={editing}
        onClose={() => setEditing(null)}
        onSubmit={async (v) => {
          if (!editing) return;
          await update.mutateAsync({ id: editing.id, input: editInput(editing, v) });
          toast.success('Cita cambiada. Se le ha avisado al comercial.');
        }}
      />
    </Card>
  );
}
