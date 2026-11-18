'use client';

import { MyAppointmentsList } from '@/components/admin/sales/appointments-views';
import { PageHeader, SalesPage } from '@/components/admin/sales/common';

export default function SalesAppointmentsPage() {
  return (
    <SalesPage>
      <PageHeader
        title="Mis citas"
        description="Llamadas, videollamadas y visitas con tus clientes. Te avisamos el día antes y una hora antes. Para poner una, entra en la ficha del cliente."
      />
      <MyAppointmentsList />
    </SalesPage>
  );
}
