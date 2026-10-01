import { z } from 'zod';

/**
 * Correos automáticos que el tenant envía a sus inquilinos. Todos activados
 * por defecto; el tenant puede apagar cada uno en Ajustes → Correo.
 */
export const CUSTOMER_EMAIL_KINDS = [
  'invoice_issued',
  'payment_received',
  'payment_failed',
  'contract_signed',
  'contract_ending_soon',
  'move_out_confirmed',
  'sepa_prenotification',
] as const;
export type CustomerEmailKind = (typeof CUSTOMER_EMAIL_KINDS)[number];

export const CUSTOMER_EMAIL_LABELS: Record<
  CustomerEmailKind,
  { label: string; description: string }
> = {
  invoice_issued: {
    label: 'Factura emitida',
    description: 'Aviso con el importe y el vencimiento de cada factura nueva.',
  },
  payment_received: {
    label: 'Pago recibido',
    description: 'Justificante cuando una factura queda pagada.',
  },
  payment_failed: {
    label: 'Cobro rechazado',
    description:
      'Aviso cuando un cobro automático (tarjeta o domiciliación) no se ha podido hacer.',
  },
  contract_signed: {
    label: 'Contrato firmado',
    description: 'Confirmación del contrato con sus datos y cómo descargarlo.',
  },
  contract_ending_soon: {
    label: 'Fin de contrato',
    description: 'Aviso 30 días antes de que termine un contrato sin renovación automática.',
  },
  move_out_confirmed: {
    label: 'Baja solicitada',
    description: 'Confirmación de la fecha de baja que ha pedido el inquilino.',
  },
  sepa_prenotification: {
    label: 'Preaviso de domiciliación',
    description:
      'Al generar una remesa SEPA: importe, fecha de cargo, cuenta y mandato (lo exige la normativa SEPA).',
  },
};

export type CustomerEmailSettingsDto = Record<CustomerEmailKind, boolean>;

export const UpdateCustomerEmailSettingsSchema = z
  .object(
    Object.fromEntries(CUSTOMER_EMAIL_KINDS.map((k) => [k, z.boolean().optional()])) as Record<
      CustomerEmailKind,
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict();
export type UpdateCustomerEmailSettingsInput = z.infer<typeof UpdateCustomerEmailSettingsSchema>;

/** Del jsonb guardado (solo los apagados) a la configuración completa. */
export function resolveCustomerEmailSettings(raw: unknown): CustomerEmailSettingsDto {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    CUSTOMER_EMAIL_KINDS.map((k) => [k, stored[k] !== false]),
  ) as CustomerEmailSettingsDto;
}

/** Avisos por email al equipo del tenant (propietarios y gestores). */
export const STAFF_EMAIL_KINDS = [
  'new_lead',
  'new_booking',
  'move_out_requested',
  'portal_incident',
] as const;
export type StaffEmailKind = (typeof STAFF_EMAIL_KINDS)[number];

export const STAFF_EMAIL_LABELS: Record<StaffEmailKind, { label: string; description: string }> = {
  new_lead: {
    label: 'Contacto nuevo desde la web',
    description: 'Alguien deja sus datos en tu web o en el formulario embebido.',
  },
  new_booking: {
    label: 'Reserva online',
    description: 'Un cliente reserva un trastero desde tu web (queda pendiente de firma y pago).',
  },
  move_out_requested: {
    label: 'Baja solicitada',
    description: 'Un inquilino pide la baja desde su área de clientes.',
  },
  portal_incident: {
    label: 'Incidencia de un inquilino',
    description: 'Un inquilino reporta una incidencia desde su área de clientes.',
  },
};

export type StaffEmailSettingsDto = Record<StaffEmailKind, boolean>;

export const UpdateStaffEmailSettingsSchema = z
  .object(
    Object.fromEntries(STAFF_EMAIL_KINDS.map((k) => [k, z.boolean().optional()])) as Record<
      StaffEmailKind,
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict();
export type UpdateStaffEmailSettingsInput = z.infer<typeof UpdateStaffEmailSettingsSchema>;

export function resolveStaffEmailSettings(raw: unknown): StaffEmailSettingsDto {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    STAFF_EMAIL_KINDS.map((k) => [k, stored[k] !== false]),
  ) as StaffEmailSettingsDto;
}
