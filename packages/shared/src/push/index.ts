import { z } from 'zod';

/** Suscripción Web Push tal como la entrega `PushSubscription.toJSON()`. */
export const PushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscribeInput = z.infer<typeof PushSubscribeSchema>;

export const PushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeSchema>;

export interface PushPublicKeyDto {
  /** Clave pública VAPID (base64url) o null si el push no está configurado. */
  publicKey: string | null;
}

/**
 * Notificaciones del panel que también llegan como push al móvil del equipo:
 * las que piden actuar pronto. El resto se quedan en la campana.
 */
export const STAFF_PUSH_TYPES: Record<string, string> = {
  'lead.created': 'Contacto nuevo desde la web',
  'lead.unattended': 'Un contacto lleva tiempo sin atender',
  'lead.assigned': 'Te han asignado un contacto',
  'customer.message': 'Mensaje de un inquilino',
  'support.reply': 'Soporte de TrasterOS te ha respondido',
  'whatsapp.message': 'Mensaje de WhatsApp',
  'whatsapp.handoff': 'El asistente de WhatsApp pide una persona',
  'whatsapp.booking': 'Reserva desde WhatsApp',
  'incident.created': 'Incidencia nueva',
  'contract.move_out_requested': 'Un inquilino pide la baja',
  'unit_request.created': 'Un inquilino quiere otro trastero',
  'unit_change.requested': 'Un inquilino pide cambiar de trastero',
  'customer.offer_interested': 'A un inquilino le interesa una oferta',
  'payment_plan.broken': 'Un plan de pagos se ha incumplido',
  'camera.alarm': 'Alarma de una cámara',
  'access.device_locked': 'Una puerta se ha bloqueado por intentos fallidos',
};

export function isStaffPushType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(STAFF_PUSH_TYPES, type);
}

export interface StaffPushStatusDto {
  /** Clave pública VAPID o null si el push no está configurado en la plataforma. */
  publicKey: string | null;
  /** Este dispositivo ya tiene el push activado para el usuario. */
  subscribed: boolean;
}

/**
 * Avisos del panel del super admin que también llegan como push a su móvil u
 * ordenador: los que piden actuar. El resto se quedan en la campana.
 */
export const SUPER_ADMIN_PUSH_TYPES: Record<string, string> = {
  support_ticket: 'Ticket de soporte nuevo o con respuesta',
  'support_ticket.assigned': 'Te han asignado un ticket de soporte',
  'approval.requested': 'Soporte pide aprobar una acción',
  'platform_contact.received': 'Mensaje desde el formulario de la web',
  'saas_payment.disputed': 'Contracargo de una suscripción',
  'saas_billing.subscription_ended': 'Una suscripción de Stripe ha terminado',
  'saas_billing.unresolved_webhook': 'Pago de Stripe sin tenant',
  'email.provider_rejected': 'El proveedor de correo rechaza envíos',
  feature_interest: 'Un tenant insiste en una función de pago',
};

export function isSuperAdminPushType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPER_ADMIN_PUSH_TYPES, type);
}

/** Igual que el del equipo: clave pública y si este dispositivo lo tiene activado. */
export type SuperAdminPushStatusDto = StaffPushStatusDto;
