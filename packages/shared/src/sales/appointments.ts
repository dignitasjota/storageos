import { z } from 'zod';

/**
 * Citas del comercial con un prospecto o cliente: presencial, llamada o
 * videollamada, con fecha y hora. Avisan al comercial al asignársela, el día
 * antes y una hora antes.
 */

export const SalesAppointmentKindEnum = z.enum(['in_person', 'call', 'video']);
export type SalesAppointmentKind = z.infer<typeof SalesAppointmentKindEnum>;

export const SALES_APPOINTMENT_KIND_LABELS: Record<SalesAppointmentKind, string> = {
  in_person: 'Presencial',
  call: 'Llamada',
  video: 'Videollamada',
};

export const SalesAppointmentStatusEnum = z.enum(['scheduled', 'done', 'cancelled', 'no_show']);
export type SalesAppointmentStatus = z.infer<typeof SalesAppointmentStatusEnum>;

export const SALES_APPOINTMENT_STATUS_LABELS: Record<SalesAppointmentStatus, string> = {
  scheduled: 'Pendiente',
  done: 'Hecha',
  cancelled: 'Cancelada',
  no_show: 'No se presentó',
};

/** Duraciones que se ofrecen (minutos). */
export const SALES_APPOINTMENT_DURATIONS = [15, 30, 45, 60, 90, 120] as const;

/** Avisos antes de la cita (minutos). */
export const SALES_APPOINTMENT_DAY_REMINDER_MINUTES = 24 * 60;
export const SALES_APPOINTMENT_HOUR_REMINDER_MINUTES = 60;

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const appointmentFields = {
  kind: SalesAppointmentKindEnum,
  title: z.string().trim().min(2).max(200),
  /** Fecha y hora con su zona (ISO 8601). */
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  /** Dirección, teléfono o enlace de la videollamada. */
  location: optionalText(500),
  notes: optionalText(2000),
};

/** Cita que se pone el comercial en la ficha de su prospecto o cliente. */
export const CreateSalesAppointmentSchema = z.object(appointmentFields);
export type CreateSalesAppointmentInput = z.infer<typeof CreateSalesAppointmentSchema>;

/** Cita que la dirección le pone a un comercial (desde la ficha del lead). */
export const AdminCreateSalesAppointmentSchema = z.object({
  ...appointmentFields,
  leadId: z.string().uuid(),
  /** Sin indicar: el comercial del lead. */
  repId: z.string().uuid().optional(),
});
export type AdminCreateSalesAppointmentInput = z.infer<typeof AdminCreateSalesAppointmentSchema>;

export const UpdateSalesAppointmentSchema = z
  .object({
    kind: SalesAppointmentKindEnum.optional(),
    title: z.string().trim().min(2).max(200).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    location: optionalText(500),
    notes: optionalText(2000),
    status: SalesAppointmentStatusEnum.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Indica algún cambio',
  });
export type UpdateSalesAppointmentInput = z.infer<typeof UpdateSalesAppointmentSchema>;

export interface SalesAppointmentDto {
  id: string;
  leadId: string;
  leadName: string;
  /** Teléfono del contacto, para llamarle desde la lista. */
  leadPhone: string | null;
  repId: string;
  repName: string;
  kind: SalesAppointmentKind;
  title: string;
  startsAt: string;
  durationMinutes: number;
  location: string | null;
  notes: string | null;
  status: SalesAppointmentStatus;
  /** La puso otra persona (la dirección), no el comercial. */
  createdByName: string | null;
  createdByOther: boolean;
  createdAt: string;
}
