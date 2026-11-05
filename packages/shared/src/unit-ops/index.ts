import { z } from 'zod';

/** Por qué está guardado un trastero. */
export type UnitHoldKind =
  | 'reservation'
  | 'online_booking'
  | 'pre_opening'
  | 'scheduled_move'
  | 'waitlist'
  | 'contract_draft';

export const UNIT_HOLD_LABELS: Record<UnitHoldKind, string> = {
  reservation: 'Reserva',
  online_booking: 'Reserva online',
  pre_opening: 'Reserva antes de la apertura',
  scheduled_move: 'Traslado programado',
  waitlist: 'Lista de espera',
  contract_draft: 'Contrato en borrador',
};

export interface UnitHoldDto {
  kind: UnitHoldKind;
  /** Para quién está guardado. */
  name: string | null;
  customerId: string | null;
  /** Hasta cuándo, si tiene fecha. */
  until: string | null;
  /** Dónde se gestiona. */
  link: string;
}

/** Fila de «Trasteros guardados». */
export interface HeldUnitDto {
  unitId: string;
  unitCode: string;
  facilityId: string;
  facilityName: string;
  unitTypeName: string | null;
  /** null = reservado sin nadie detrás: se puede liberar a mano. */
  hold: UnitHoldDto | null;
}

// --- Ajustes -------------------------------------------------------------------

export const ReservationSignalPolicyEnum = z.enum(['refund', 'keep']);
export type ReservationSignalPolicy = z.infer<typeof ReservationSignalPolicyEnum>;

export const UpdateReservationSettingsSchema = z.object({
  /** Señal cobrada de una reserva que se cae: se devuelve o se la queda el negocio. */
  signalPolicy: ReservationSignalPolicyEnum.optional(),
  /** Horas que se guarda el trastero a quien recibe el aviso. */
  waitlistHoldHours: z.number().int().min(12).max(168).optional(),
  /** Días en cola antes de preguntar si sigue buscando (0 = no se pregunta). */
  waitlistStaleDays: z.number().int().min(0).max(365).optional(),
});
export type UpdateReservationSettingsInput = z.infer<typeof UpdateReservationSettingsSchema>;

export interface ReservationSettingsDto {
  signalPolicy: ReservationSignalPolicy;
  waitlistHoldHours: number;
  waitlistStaleDays: number;
}

// --- Reservas ------------------------------------------------------------------

export const UpdateReservationSchema = z
  .object({
    validUntil: z.string().datetime().optional(),
    customerId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nada que cambiar' });
export type UpdateReservationInput = z.infer<typeof UpdateReservationSchema>;

export interface ReservationStatsDto {
  days: number;
  created: number;
  converted: number;
  expired: number;
  cancelled: number;
  /** Convertidas sobre las ya cerradas, en %; null sin cerradas. */
  conversionPct: number | null;
  /** Señales cobradas en el periodo. */
  signalsPaid: number;
  /** Horas de mediana hasta responder a una petición de trastero; null sin respuestas. */
  requestResponseHours: number | null;
  requestsAnswered: number;
}

// --- Lista de espera -----------------------------------------------------------

/** Demanda por local y tamaño. */
export interface WaitlistDemandRowDto {
  facilityId: string;
  facilityName: string;
  unitTypeId: string;
  unitTypeName: string;
  waiting: number;
  /** Días que lleva esperando el primero de la cola. */
  oldestDays: number;
  /** Trasteros libres de ese tamaño ahora mismo. */
  freeUnits: number;
  /** Avisos de los últimos 180 días: acabaron en contrato frente a sin respuesta. */
  converted: number;
  expired: number;
  /** Convertidos sobre avisos cerrados, en %; null sin avisos cerrados. */
  conversionPct: number | null;
}

/** Trastero con baja pedida que se puede preasignar. */
export interface UpcomingUnitDto {
  unitId: string;
  unitCode: string;
  /** Día en que sale el inquilino actual. */
  endDate: string;
  preassignedTo: string | null;
}

export const PreassignWaitlistSchema = z.object({
  unitId: z.string().uuid().nullable(),
});
export type PreassignWaitlistInput = z.infer<typeof PreassignWaitlistSchema>;

/** Respuesta del enlace «¿Sigues buscando?». */
export const WaitlistInterestSchema = z.object({ stillInterested: z.boolean() });
export type WaitlistInterestInput = z.infer<typeof WaitlistInterestSchema>;

export interface WaitlistInterestViewDto {
  tenantName: string;
  facilityName: string;
  unitTypeName: string;
  contactName: string;
  /** Ya no está en la cola o ya respondió. */
  closed: boolean;
}

// --- Peticiones ----------------------------------------------------------------

/** Trastero libre parecido al que pidió el inquilino. */
export interface UnitAlternativeDto {
  unitId: string;
  unitCode: string;
  unitTypeName: string | null;
  areaM2: number | null;
  priceMonthly: number;
}

export const UnitRequestToWaitlistSchema = z.object({
  facilityId: z.string().uuid().optional(),
  unitTypeId: z.string().uuid().optional(),
});
export type UnitRequestToWaitlistInput = z.infer<typeof UnitRequestToWaitlistSchema>;

// --- Bandeja -------------------------------------------------------------------

export const UnitInboxKindEnum = z.enum(['change', 'request', 'waitlist', 'reservation']);
export type UnitInboxKind = z.infer<typeof UnitInboxKindEnum>;

export const UNIT_INBOX_LABELS: Record<UnitInboxKind, string> = {
  change: 'Cambio de trastero',
  request: 'Solicitud de trastero',
  waitlist: 'Lista de espera con hueco',
  reservation: 'Reserva que caduca',
};

export interface UnitInboxItemDto {
  kind: UnitInboxKind;
  id: string;
  title: string;
  detail: string | null;
  facilityName: string | null;
  /** Desde cuándo espera respuesta. */
  since: string;
  /** Días esperando (entero). */
  ageDays: number;
  /** Caduca: la reserva o el aviso. */
  dueAt: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  link: string;
}

export interface UnitInboxDto {
  items: UnitInboxItemDto[];
  counts: Record<UnitInboxKind, number>;
}

export const AssignUnitInboxSchema = z.object({ userId: z.string().uuid().nullable() });
export type AssignUnitInboxInput = z.infer<typeof AssignUnitInboxSchema>;
