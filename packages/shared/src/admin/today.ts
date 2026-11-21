import type { AdminTodayDto } from './types';

/** Secciones de «Hoy» que pueden fallar por separado, con su nombre para el aviso. */
export const ADMIN_TODAY_SECTION_LABELS: Record<string, string> = {
  addonCharges: 'cobros de extras',
  manualRenewalsDue: 'renovaciones manuales',
  staleSuspendedAddons: 'extras suspendidos',
  atRisk: 'pruebas e impagos',
  trialUsage: 'uso de las pruebas',
  followups: 'seguimientos',
  openTickets: 'tickets de soporte',
  failedJobs: 'colas',
  failedWebhooks: 'webhooks',
  aeatIssues: 'Veri*Factu',
  certificatesExpiring: 'certificados de la AEAT',
  holdedReview: 'Holded',
  devicesOffline: 'dispositivos de acceso',
  crons: 'tareas programadas',
  pendingApprovals: 'aprobaciones',
  expiringOverrides: 'cortesías y pruebas gratis',
  kpis: 'cifras',
  activity: 'actividad',
  businessGoals: 'objetivos',
  snoozes: 'avisos apartados',
  newLeads: 'leads nuevos',
  leadFollowupsDue: 'seguimientos de leads',
  domainsReady: 'dominios propios',
  incompleteInvoices: 'facturas sin datos fiscales',
  rgpdOverdue: 'solicitudes RGPD',
  npsNegative: 'respuestas NPS',
  activationStalled: 'pruebas sin arrancar',
  workload: 'reparto del trabajo',
  done: 'lo hecho hoy',
};

export function adminTodaySectionLabel(key: string): string {
  return ADMIN_TODAY_SECTION_LABELS[key] ?? key;
}

/** Lo que entra en el cálculo de urgentes (la bandeja entera o la de «Lo mío»). */
export type AdminTodayUrgencySource = Pick<
  AdminTodayDto,
  | 'pendingApprovals'
  | 'addonCharges'
  | 'pastDue'
  | 'manualRenewalsDue'
  | 'followupsDue'
  | 'openTickets'
  | 'expiringOverrides'
  | 'newLeads'
  | 'leadFollowupsDue'
  | 'domainsReady'
  | 'rgpdOverdue'
  | 'aeatIssues'
  | 'certificatesExpiring'
  | 'holdedReview'
  | 'devicesOffline'
  | 'overdueCrons'
  | 'failedWebhooks'
  | 'failedJobs'
>;

/**
 * Urgentes de «Hoy» por pestaña. La misma cuenta en el servidor (cabecera y
 * contador del menú) y en la web (pestañas), para que siempre cuadren:
 * `business + ops = total`. Lo que tiene días por delante va a «Esta semana» y
 * no es urgente; un lead ya asignado a un comercial tampoco.
 */
export function adminTodayUrgentCounts(d: AdminTodayUrgencySource): {
  business: number;
  ops: number;
  total: number;
} {
  const business =
    d.pendingApprovals.length +
    d.addonCharges.length +
    d.pastDue.length +
    d.manualRenewalsDue.filter((r) => r.daysLeft <= 1).length +
    d.followupsDue.length +
    d.openTickets.length +
    d.expiringOverrides.filter((o) => o.daysLeft <= 1).length +
    d.newLeads.filter((l) => !l.assignedToId).length +
    d.leadFollowupsDue.length +
    d.domainsReady.length +
    d.rgpdOverdue.length;
  const ops =
    d.aeatIssues.length +
    d.certificatesExpiring.filter((c) => c.daysLeft <= 15).length +
    d.holdedReview.length +
    d.devicesOffline.length +
    d.overdueCrons.length +
    d.failedWebhooks.length +
    (d.failedJobs > 0 ? 1 : 0);
  return { business, ops, total: business + ops };
}

/** «1 acción urgente», «3 acciones urgentes». */
export function pluralEs(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
