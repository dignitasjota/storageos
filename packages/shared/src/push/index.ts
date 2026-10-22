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
  'customer.message': 'Mensaje de un inquilino',
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
