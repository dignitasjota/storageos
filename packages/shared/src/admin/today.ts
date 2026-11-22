import type { AdminTodayDto, AdminTodayVisitDto, AdminTodayVisitItemDto } from './types';

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
  paymentFailures: 'cobros rechazados',
  inactivePaying: 'clientes que han dejado de entrar',
  monthly: 'cuotas de los tenants',
  responseTargets: 'plazos de respuesta',
  // Solo para el resumen de la última visita.
  pastDue: 'pagos pendientes',
  trialsExpiring: 'pruebas que terminan',
  followupsDue: 'seguimientos',
  assignedLeads: 'leads asignados sin atender',
  failedJobsList: 'colas',
  overdueCrons: 'tareas programadas',
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
  | 'assignedLeads'
  | 'paymentFailures'
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

/** Un ticket es urgente si su plazo de respuesta vence en menos de estas horas (o ya venció). */
export const TICKET_URGENT_HOURS = 2;

/** Un ticket con prioridad «urgente» lo es siempre; el resto, por su plazo. */
export function isTicketUrgent(t: { priority: string; dueInHours: number }): boolean {
  return t.priority === 'urgent' || t.dueInHours < TICKET_URGENT_HOURS;
}

/**
 * Urgentes de «Hoy» por pestaña. La misma cuenta en el servidor (cabecera y
 * contador del menú) y en la web (pestañas), para que siempre cuadren:
 * `business + ops = total`. Lo que tiene días por delante va a «Esta semana» y
 * no es urgente; un lead ya asignado tampoco, salvo en «Lo mío» de quien lo
 * tiene (`mine`). De los tickets abiertos, los de prioridad urgente y los que
 * vencen en menos de 2 h o ya están fuera de plazo.
 */
export function adminTodayUrgentCounts(
  d: AdminTodayUrgencySource,
  options: { mine?: boolean } = {},
): {
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
    d.openTickets.filter(isTicketUrgent).length +
    d.expiringOverrides.filter((o) => o.daysLeft <= 1).length +
    d.newLeads.filter((l) => !l.assignedToId).length +
    (options.mine ? d.assignedLeads.length : 0) +
    d.paymentFailures.length +
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

/** Un aviso tal como se guarda en la foto de la última visita. */
export interface AdminTodayVisitSnapshotItem extends AdminTodayVisitItemDto {
  reappeared: boolean;
}

/**
 * Los avisos de la bandeja con una clave estable (`tipo:id`), para comparar con
 * la última visita. Las claves usan el mismo tipo que al apartar un aviso, así
 * que lo apartado no se toma por resuelto.
 */
export function adminTodayVisitItems(d: AdminTodayDto): AdminTodayVisitSnapshotItem[] {
  const out: AdminTodayVisitSnapshotItem[] = [];
  const add = (
    section: string,
    key: string,
    label: string,
    href: string,
    reappeared?: boolean,
  ): void => {
    out.push({ key, section, label, href, reappeared: reappeared === true });
  };
  const tenant = (id: string) => `/admin/tenants/${id}`;
  d.pendingApprovals.forEach((a) =>
    add('pendingApprovals', `approval:${a.id}`, `${a.tenantName}: ${a.summary}`, '/admin/today'),
  );
  d.addonCharges.forEach((c) =>
    add(
      'addonCharges',
      `addon_charge:${c.tenantAddonId}`,
      `${c.tenantName} · ${c.addonName}`,
      tenant(c.tenantId),
      c.reappeared,
    ),
  );
  d.pastDue.forEach((t) => add('pastDue', `past_due:${t.id}`, t.name, tenant(t.id), t.reappeared));
  d.paymentFailures.forEach((p) =>
    add(
      'paymentFailures',
      `payment_failure:${p.tenantId}`,
      p.tenantName,
      `${tenant(p.tenantId)}?tab=payments`,
      p.reappeared,
    ),
  );
  d.manualRenewalsDue.forEach((r) =>
    add(
      'manualRenewalsDue',
      `renewal:${r.tenantId}`,
      r.tenantName,
      tenant(r.tenantId),
      r.reappeared,
    ),
  );
  d.trialsExpiring.forEach((t) =>
    add('trialsExpiring', `trial:${t.id}`, t.name, tenant(t.id), t.reappeared),
  );
  d.followupsDue.forEach((f) =>
    add('followupsDue', `followup:${f.id}`, `${f.tenantName}: ${f.title}`, tenant(f.tenantId)),
  );
  d.openTickets.forEach((t) =>
    add(
      'openTickets',
      `ticket:${t.id}`,
      `${t.tenantName}: ${t.subject}`,
      `/admin/support/${t.id}`,
      t.reappeared,
    ),
  );
  [...d.newLeads, ...d.assignedLeads].forEach((l) =>
    add('newLeads', `contact:${l.id}`, l.name, `/admin/leads?lead=${l.id}`),
  );
  d.leadFollowupsDue.forEach((f) =>
    add(
      'leadFollowupsDue',
      `lead_followup:${f.id}`,
      `${f.leadName}: ${f.title}`,
      `/admin/leads?lead=${f.leadId}`,
    ),
  );
  d.domainsReady.forEach((x) =>
    add('domainsReady', `domain:${x.tenantId}`, x.tenantName, '/admin/custom-domains'),
  );
  const issues: [string, string, AdminTodayDto['aeatIssues']][] = [
    ['rgpdOverdue', 'rgpd', d.rgpdOverdue],
    ['incompleteInvoices', 'invoice_data', d.incompleteInvoices],
    ['aeatIssues', 'aeat', d.aeatIssues],
    ['holdedReview', 'holded', d.holdedReview],
    ['devicesOffline', 'device', d.devicesOffline],
  ];
  for (const [section, kind, list] of issues) {
    list.forEach((t) =>
      add(section, `${kind}:${t.tenantId}`, t.tenantName, tenant(t.tenantId), t.reappeared),
    );
  }
  d.certificatesExpiring.forEach((c) =>
    add(
      'certificatesExpiring',
      `certificate:${c.id}`,
      c.tenantName,
      tenant(c.tenantId),
      c.reappeared,
    ),
  );
  d.overdueCrons.forEach((c) => add('overdueCrons', `cron:${c.name}`, c.name, '/admin/queues'));
  d.failedWebhooks.forEach((w) =>
    add('failedWebhooks', `webhook:${w.tenantId}`, w.tenantName, tenant(w.tenantId), w.reappeared),
  );
  d.failedJobsList.forEach((j) =>
    add('failedJobsList', `job:${j.queue}:${j.id}`, `${j.queue} · ${j.name}`, '/admin/queues'),
  );
  d.inactivePaying.forEach((t) =>
    add('inactivePaying', `inactive:${t.tenantId}`, t.tenantName, tenant(t.tenantId), t.reappeared),
  );
  d.activationStalled.forEach((a) =>
    add('activationStalled', `activation:${a.tenantId}`, a.tenantName, tenant(a.tenantId)),
  );
  d.npsNegative.forEach((n) => add('npsNegative', `nps:${n.id}`, n.tenantName, tenant(n.tenantId)));
  d.expiringOverrides.forEach((o) =>
    add(
      'expiringOverrides',
      `override:${o.tenantId}-${o.feature}`,
      o.tenantName,
      tenant(o.tenantId),
    ),
  );
  d.staleSuspendedAddons.forEach((a) =>
    add(
      'staleSuspendedAddons',
      `stale_addon:${a.tenantAddonId}`,
      `${a.tenantName} · ${a.addonName}`,
      tenant(a.tenantId),
    ),
  );
  return out;
}

/** Cuántos de cada lista enseña el resumen de la última visita. */
const VISIT_LIST_MAX = 20;
/** Por debajo de este rato desde la última visita, el resumen no sale. */
export const ADMIN_TODAY_VISIT_MIN_HOURS = 1;

/**
 * Compara la bandeja de ahora con la foto de la última visita: lo nuevo, lo
 * resuelto (lo que ya no sale y no está apartado) y lo que ha empeorado (los
 * apartados que han vuelto a salir desde entonces).
 */
export function adminTodayVisitSummary(
  previous: { seenAt: Date; items: AdminTodayVisitSnapshotItem[] } | null,
  current: AdminTodayVisitSnapshotItem[],
  snoozedKeys: ReadonlySet<string>,
  now: Date,
): AdminTodayVisitDto {
  if (!previous) {
    return {
      previousVisitAt: null,
      show: false,
      newCount: 0,
      resolvedCount: 0,
      worseCount: 0,
      newItems: [],
      resolvedItems: [],
      worseItems: [],
    };
  }
  const strip = ({ key, section, label, href }: AdminTodayVisitSnapshotItem) => ({
    key,
    section,
    label,
    href,
  });
  const before = new Map(previous.items.map((i) => [i.key, i]));
  const nowKeys = new Set(current.map((i) => i.key));
  // Un aviso apartado que vuelve a salir ha empeorado, no es nuevo.
  const worse = current.filter((i) => i.reappeared && before.get(i.key)?.reappeared !== true);
  const worseKeys = new Set(worse.map((i) => i.key));
  const added = current.filter((i) => !before.has(i.key) && !worseKeys.has(i.key));
  const resolved = previous.items.filter((i) => !nowKeys.has(i.key) && !snoozedKeys.has(i.key));
  const hours = (now.getTime() - previous.seenAt.getTime()) / 3_600_000;
  return {
    previousVisitAt: previous.seenAt.toISOString(),
    show: hours >= ADMIN_TODAY_VISIT_MIN_HOURS,
    newCount: added.length,
    resolvedCount: resolved.length,
    worseCount: worse.length,
    newItems: added.slice(0, VISIT_LIST_MAX).map(strip),
    resolvedItems: resolved.slice(0, VISIT_LIST_MAX).map(strip),
    worseItems: worse.slice(0, VISIT_LIST_MAX).map(strip),
  };
}
