'use client';

import { TeamAppointmentsList } from '@/components/admin/sales/appointments-views';
import { PageHeader, SalesPage } from '@/components/admin/sales/common';
import { useSalesTeam } from '@/lib/admin/sales-team-hooks';

export default function SalesTeamAppointmentsPage() {
  const team = useSalesTeam();
  const reps = (team.data?.reps ?? []).map((r) => ({ id: r.id, fullName: r.fullName }));
  return (
    <SalesPage>
      <PageHeader
        title="Citas de los comerciales"
        description="Para ponerle una cita a un comercial, abre el lead y entra en la pestaña «Citas». Al comercial le llega un aviso al ponérsela, el día antes y una hora antes."
      />
      <TeamAppointmentsList reps={reps} />
    </SalesPage>
  );
}
