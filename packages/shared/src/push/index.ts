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
