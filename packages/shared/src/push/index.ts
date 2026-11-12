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
  'today.daily_summary': 'Resumen del día',
  'lead.created': 'Contacto nuevo desde la web',
  'booking.created': 'Reserva online nueva',
  'lead.unattended': 'Un contacto lleva tiempo sin atender',
  'lead.assigned': 'Te han asignado un contacto',
  'customer.message': 'Mensaje de un inquilino',
  'customer.message_unanswered': 'Un inquilino lleva un día sin respuesta',
  'customer.conversation_assigned': 'Te han asignado una conversación',
  'support.reply': 'Soporte de TrasterOS te ha respondido',
  'whatsapp.message': 'Mensaje de WhatsApp',
  'whatsapp.handoff': 'El asistente de WhatsApp pide una persona',
  'whatsapp.booking': 'Reserva desde WhatsApp',
  'whatsapp.intent': 'Un contacto de WhatsApp escribe por algo importante',
  'web_chat.handoff': 'Un visitante de tu web quiere hablar con una persona',
  'web_chat.message': 'Mensaje en el chat de tu web',
  'web_chat.booking': 'Reserva desde el chat de tu web',
  'incident.created': 'Incidencia nueva',
  'incident.assigned': 'Te han asignado una incidencia',
  'task.assigned': 'Te han asignado una tarea',
  'contract.move_out_requested': 'Un inquilino pide la baja',
  'unit_request.created': 'Un inquilino quiere otro trastero',
  'unit_change.requested': 'Un inquilino pide cambiar de trastero',
  'customer.offer_interested': 'A un inquilino le interesa una oferta',
  'payment_plan.broken': 'Un plan de pagos se ha incumplido',
  'collections.long_overdue': 'Un impago lleva tiempo sin resolverse',
  'collections.case_opened': 'Se ha abierto un expediente de impago',
  'collections.surplus_to_return': 'Hay que devolver dinero tras un impago',
  'collections.case_closed_paid': 'Un impago se ha pagado: retira el candado',
  'collections.deadline_soon': 'Vence pronto el plazo de un requerimiento de pago',
  'collections.abandonment_possible': 'Ya se puede dar por abandonados unos bienes',
  'collections.stalled': 'Un expediente de impago lleva tiempo parado',
  'collections.pickup_requested': 'Un inquilino pide cita para retirar sus bienes',
  'collections.plan_broken': 'Un plan de pagos se ha roto: el expediente sigue',
  'camera.alarm': 'Alarma de una cámara',
  'access.device_locked': 'Una puerta se ha bloqueado por intentos fallidos',
  'access.cut_attempt': 'Un inquilino con el acceso cortado intenta entrar',
  'access.night_attempt': 'Alguien intenta entrar fuera de horario',
  'access.device_offline': 'Una puerta se ha quedado sin conexión',
  'business_reminder.due': 'Se acerca un vencimiento del negocio',
  'invoice.offline_payment_chosen':
    'Un inquilino pagará por transferencia, en el local o domiciliando',
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
  'security.brute_force': 'Posible ataque de fuerza bruta',
  'system.attention': 'Una tarea programada o el worker no responden',
  'today.attention': 'Algo urgente nuevo en «Hoy»',
};

export function isSuperAdminPushType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPER_ADMIN_PUSH_TYPES, type);
}

/** Igual que el del equipo: clave pública y si este dispositivo lo tiene activado. */
export type SuperAdminPushStatusDto = StaffPushStatusDto;
