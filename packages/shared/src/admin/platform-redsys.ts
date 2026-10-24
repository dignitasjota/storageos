/**
 * Pago de la suscripción de un tenant con el TPV (Redsys) de la plataforma.
 * La configuración del TPV usa los mismos esquemas que el Redsys de los
 * tenants (`UpdateRedsysSettingsSchema` / `RedsysSettingsDto`).
 */

/** Lo que ve el tenant en Suscripción para pagar con tarjeta o Bizum. */
export interface TenantRedsysPaymentOptionsDto {
  /** Se le puede ofrecer el pago con el TPV de la plataforma. */
  available: boolean;
  cardEnabled: boolean;
  bizumEnabled: boolean;
  /** Importe del periodo siguiente (IVA incluido). */
  amount: number;
  currency: string;
  /** Fin del periodo pagado: el pago lo extiende un mes desde aquí. */
  currentPeriodEnd: string | null;
  /** La suscripción tiene un pago pendiente. */
  pastDue: boolean;
  planName: string | null;
  /** El TPV admite guardar la tarjeta y cobrar solo cada mes. */
  cardOnFileAvailable: boolean;
  /** La suscripción se cobra sola con la tarjeta guardada. */
  autoCharge: boolean;
  savedCard: {
    last4: string | null;
    brand: string | null;
    expMonth: number | null;
    expYear: number | null;
    /** Motivo del último cobro automático rechazado. */
    lastError: string | null;
  } | null;
  /** Por qué no se ofrece (cuando `available` es false). */
  reason: 'not_configured' | 'not_manual' | 'free_plan' | 'exempt' | 'no_subscription' | null;
}
