import { z } from 'zod';

/**
 * Stripe Connect: cada tenant conecta su cuenta de Stripe (Express) para cobrar
 * con tarjeta a sus inquilinos. El dinero va a su cuenta; la plataforma cobra
 * una comisión por cobro (`applicationFeePct`, configurable en el panel admin).
 */

/** Con qué se cobra la tarjeta a los inquilinos. */
export const CardProviderEnum = z.enum(['redsys', 'stripe']);
export type CardProvider = z.infer<typeof CardProviderEnum>;

export const UpdateCardProviderSchema = z.object({
  /** null = Redsys si está activo (comportamiento de siempre). */
  provider: CardProviderEnum.nullable(),
});
export type UpdateCardProviderInput = z.infer<typeof UpdateCardProviderSchema>;

export interface StripeConnectStatusDto {
  /** La plataforma tiene Stripe configurado (si no, no se puede conectar). */
  platformAvailable: boolean;
  connected: boolean;
  /** Id de la cuenta conectada (acct_…). */
  accountId: string | null;
  /** Stripe ya permite cobrar con esta cuenta. */
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Datos que Stripe aún pide para activar la cuenta. */
  requirementsDue: string[];
  disabledReason: string | null;
  /** Comisión de la plataforma por cobro (%). */
  applicationFeePct: number;
  /** Proveedor elegido para la tarjeta (null = Redsys si está activo). */
  cardProvider: CardProvider | null;
  /** Proveedor que se usa de verdad ahora mismo. */
  effectiveCardProvider: CardProvider | null;
  redsysEnabled: boolean;
}

export interface StripeConnectLinkDto {
  url: string;
}

export interface PlatformPaymentSettingsDto {
  applicationFeePct: number;
  /** Tenants con la cuenta de Stripe conectada y activa. */
  connectedTenants: number;
}

export const UpdatePlatformPaymentSettingsSchema = z.object({
  applicationFeePct: z.number().min(0).max(10),
});
export type UpdatePlatformPaymentSettingsInput = z.infer<
  typeof UpdatePlatformPaymentSettingsSchema
>;
