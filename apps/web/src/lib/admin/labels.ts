/**
 * Etiquetas en español para estados de tenant y de suscripción del panel super
 * admin. Centralizadas aquí para que todas las páginas (tenants, detalle,
 * métricas, soporte) rendericen los mismos textos en vez de valores crudos en
 * inglés. Se usan con fallback: `TENANT_STATUS_LABELS[s] ?? s`.
 */

/** Estado del tenant (`tenants.status`). */
export const TENANT_STATUS_LABELS: Record<string, string> = {
  trial: 'Prueba',
  active: 'Activo',
  suspended: 'Suspendido',
  cancelled: 'Cancelado',
};

/** Estado de la suscripción SaaS (`tenant_subscription.status`, valores Stripe). */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  active: 'Activa',
  trialing: 'En prueba',
  past_due: 'Pago pendiente',
  canceled: 'Cancelada',
  cancelled: 'Cancelada',
  unpaid: 'Impagada',
  incomplete: 'Incompleta',
  incomplete_expired: 'Incompleta (caducada)',
  paused: 'Pausada',
};

/** Devuelve la etiqueta del estado del tenant (fallback al valor crudo). */
export function tenantStatusLabel(status: string): string {
  return TENANT_STATUS_LABELS[status] ?? status;
}

/** Devuelve la etiqueta del estado de la suscripción (fallback al valor crudo). */
export function subscriptionStatusLabel(status: string): string {
  return SUBSCRIPTION_STATUS_LABELS[status] ?? status;
}
