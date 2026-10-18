import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminTimelineItemDto,
  AdminTimelineKind,
  AdminTimelinePageDto,
} from '@storageos/shared';

const eur = (n: unknown) =>
  Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/** Textos de las acciones del super admin sobre un tenant. */
const ACTION_LABELS: Record<string, string> = {
  'admin.tenant.updated': 'Datos del tenant editados',
  'admin.tenant.plan_changed': 'Plan cambiado',
  'admin.tenant.suspended': 'Tenant suspendido',
  'admin.tenant.reactivated': 'Tenant reactivado',
  'admin.tenant.trial_extended': 'Prueba ampliada',
  'admin.tenant.trial_ended': 'Prueba finalizada',
  'admin.tenant.billing_exempted': 'Marcado como exento',
  'admin.tenant.billing_unexempted': 'Exención retirada',
  'admin.tenant.billing_mode_changed': 'Modo de cobro cambiado',
  'admin.tenant.switched_to_manual_billing': 'Pasado a pago manual',
  'admin.tenant.saas_payment_manual_created': 'Pago manual registrado',
  'admin.tenant.sepa_mandate_cancelled': 'Mandato SEPA cancelado',
  'admin.tenant.features_changed': 'Funciones cambiadas',
  'admin.tenant.notes_updated': 'Notas y valor actualizados',
  'admin.tenant.retention_playbook': 'Playbook de retención lanzado',
  'admin.tenant.custom_domain_verified': 'Dominio propio activado',
  'admin.tenant.custom_domain_revoked': 'Dominio propio desactivado',
  'admin.tenant.data_exported': 'Datos exportados',
  'admin.tenant.anonymized': 'Tenant anonimizado',
  'admin.tenant.whatsapp_ai_changed': 'IA de WhatsApp cambiada',
  'admin.saas_addon.assigned': 'Extra asignado',
  'admin.saas_addon.removed': 'Extra quitado',
  'admin.saas_addon.suspended': 'Extra suspendido',
  'admin.saas_addon.reactivated': 'Extra reactivado',
  'admin.saas_addon.billing_mode_changed': 'Cobro de un extra cambiado',
};

/** Acciones que ya salen por su propio origen (no se duplican). */
const SKIP_ACTIONS = new Set([
  'admin.tenant.impersonate',
  'admin.impersonation.started',
  'admin.tenant.interaction_created',
  'admin.tenant.interaction_deleted',
  'admin.tenant.followup_created',
  'admin.tenant.email_sent',
]);

const NEGATIVE_ACTIONS = new Set(['admin.tenant.suspended', 'admin.tenant.anonymized']);

const INTERACTION_LABELS: Record<string, string> = {
  note: 'Nota',
  call: 'Llamada',
  email: 'Email',
  meeting: 'Reunión',
  whatsapp: 'WhatsApp',
  support: 'Ticket de soporte',
  other: 'Conversación',
};

const LIFECYCLE_LABELS: Record<string, string> = {
  welcome: 'Correo de bienvenida',
  trial_7d: 'Aviso: la prueba termina en 7 días',
  trial_3d: 'Aviso: la prueba termina en 3 días',
  trial_1d: 'Aviso: la prueba termina mañana',
  past_due: 'Aviso de pago pendiente',
};

/**
 * Historial unificado de un tenant para el panel admin: conversaciones,
 * acciones del super admin, impersonaciones, pagos y facturas de la
 * suscripción, tickets, correos de la plataforma y seguimientos. Cada origen
 * aporta como mucho `limit` eventos anteriores a `before`; se mezclan,
 * ordenan y se corta (paginación por fecha).
 */
@Injectable()
export class AdminTenantTimelineService {
  constructor(private readonly admin: PrismaAdminService) {}

  async page(
    tenantId: string,
    args: { before?: Date; limit?: number; kinds?: AdminTimelineKind[] },
  ): Promise<AdminTimelinePageDto> {
    const exists = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const limit = Math.min(Math.max(args.limit ?? 40, 1), 100);
    const before = args.before ?? new Date(Date.now() + 60_000);
    const want = (k: AdminTimelineKind) => !args.kinds?.length || args.kinds.includes(k);
    const lt = { lt: before };
    const take = limit;
    const none = Promise.resolve([] as AdminTimelineItemDto[]);

    const sources: Promise<AdminTimelineItemDto[]>[] = [
      want('interaction')
        ? this.admin.tenantInteraction
            .findMany({
              where: { tenantId, occurredAt: lt },
              orderBy: { occurredAt: 'desc' },
              take,
              include: { superAdmin: { select: { fullName: true } } },
            })
            .then((rows) =>
              rows.map((r) => ({
                id: `interaction:${r.id}`,
                kind: 'interaction' as const,
                at: r.occurredAt.toISOString(),
                title: INTERACTION_LABELS[r.type] ?? 'Conversación',
                detail: r.content,
                actor: r.superAdmin?.fullName ?? null,
                link: r.link,
                tone: 'neutral' as const,
              })),
            )
        : none,
      want('admin_action')
        ? this.admin.superAdminAuditLog
            .findMany({
              where: {
                targetTenantId: tenantId,
                occurredAt: lt,
                action: { notIn: [...SKIP_ACTIONS] },
              },
              orderBy: { occurredAt: 'desc' },
              take,
              include: { superAdmin: { select: { fullName: true } } },
            })
            .then((rows) =>
              rows.map((r) => {
                const changes = (r.changes ?? {}) as Record<string, unknown>;
                const reason = typeof changes.reason === 'string' ? changes.reason : null;
                return {
                  id: `admin_action:${r.id}`,
                  kind: 'admin_action' as const,
                  at: r.occurredAt.toISOString(),
                  title: ACTION_LABELS[r.action] ?? r.action,
                  detail: reason,
                  actor: r.superAdmin?.fullName ?? null,
                  link: null,
                  tone: NEGATIVE_ACTIONS.has(r.action)
                    ? ('negative' as const)
                    : ('neutral' as const),
                };
              }),
            )
        : none,
      want('impersonation')
        ? this.admin.impersonationLog
            .findMany({
              where: { tenantId, createdAt: lt },
              orderBy: { createdAt: 'desc' },
              take,
              include: { superAdmin: { select: { fullName: true } } },
            })
            .then((rows) =>
              rows.map((r) => ({
                id: `impersonation:${r.id}`,
                kind: 'impersonation' as const,
                at: r.createdAt.toISOString(),
                title: r.revokedAt ? 'Impersonación (revocada)' : 'Impersonación',
                detail: r.reason,
                actor: r.superAdmin.fullName,
                link: '/admin/impersonation',
                tone: 'warning' as const,
              })),
            )
        : none,
      want('payment')
        ? this.admin.tenantSubscriptionPayment
            .findMany({
              where: { tenantId, createdAt: lt },
              orderBy: { createdAt: 'desc' },
              take,
            })
            .then((rows) =>
              rows.map((r) => {
                const failed = r.status === 'failed';
                const refunded = Number(r.refundedAmount) > 0;
                return {
                  id: `payment:${r.id}`,
                  kind: 'payment' as const,
                  at: (r.paidAt ?? r.createdAt).toISOString(),
                  title: failed
                    ? `Cobro fallido · ${eur(r.amount)}`
                    : refunded
                      ? `Pago de ${eur(r.amount)} (devuelto ${eur(r.refundedAmount)})`
                      : `Pago de ${eur(r.amount)}`,
                  detail:
                    [r.description ?? r.planName, r.provider].filter(Boolean).join(' · ') || null,
                  actor: null,
                  link: null,
                  tone: failed || refunded ? ('negative' as const) : ('positive' as const),
                };
              }),
            )
        : none,
      want('invoice')
        ? this.admin.platformInvoice
            .findMany({
              where: { tenantId, issuedAt: lt },
              orderBy: { issuedAt: 'desc' },
              take,
            })
            .then((rows) =>
              rows.map((r) => ({
                id: `invoice:${r.id}`,
                kind: 'invoice' as const,
                at: r.issuedAt.toISOString(),
                title: `${r.invoiceType.startsWith('R') ? 'Rectificativa' : 'Factura'} ${r.fullNumber} · ${eur(r.total)}`,
                detail: r.concept ?? (r.planName ? `Suscripción ${r.planName}` : null),
                actor: null,
                link: null,
                tone: 'neutral' as const,
              })),
            )
        : none,
      want('ticket')
        ? this.admin.supportTicket
            .findMany({
              where: { tenantId, createdAt: lt },
              orderBy: { createdAt: 'desc' },
              take,
            })
            .then((rows) =>
              rows.map((r) => ({
                id: `ticket:${r.id}`,
                kind: 'ticket' as const,
                at: r.createdAt.toISOString(),
                title: `Ticket: ${r.subject}`,
                detail: r.status === 'resolved' || r.status === 'closed' ? 'Resuelto' : 'Abierto',
                actor: null,
                link: `/admin/support/${r.id}`,
                tone:
                  r.status === 'resolved' || r.status === 'closed'
                    ? ('neutral' as const)
                    : ('warning' as const),
              })),
            )
        : none,
      want('email')
        ? Promise.all([
            this.admin.platformEmailLog.findMany({
              // Los emails del admin ya salen como conversación.
              where: { tenantId, createdAt: lt, NOT: { kind: 'admin_message' } },
              orderBy: { createdAt: 'desc' },
              take,
            }),
            this.admin.tenantLifecycleEmail.findMany({
              where: { tenantId, sentAt: lt },
              orderBy: { sentAt: 'desc' },
              take,
            }),
          ]).then(([logs, lifecycle]) => [
            ...logs.map((r) => ({
              id: `email:${r.id}`,
              kind: 'email' as const,
              at: r.createdAt.toISOString(),
              title: `Correo: ${r.subject}`,
              detail:
                r.status === 'bounced' || r.status === 'failed' || r.status === 'suppressed'
                  ? `No entregado a ${r.recipient}`
                  : r.recipient,
              actor: null,
              link: null,
              tone:
                r.status === 'bounced' || r.status === 'failed' || r.status === 'suppressed'
                  ? ('negative' as const)
                  : ('neutral' as const),
            })),
            ...lifecycle.map((r) => ({
              id: `lifecycle:${r.id}`,
              kind: 'email' as const,
              at: r.sentAt.toISOString(),
              title: LIFECYCLE_LABELS[r.type] ?? `Correo automático (${r.type})`,
              detail: null,
              actor: null,
              link: null,
              tone: 'neutral' as const,
            })),
          ])
        : none,
      want('followup')
        ? this.admin.tenantFollowup
            .findMany({
              where: { tenantId, createdAt: lt },
              orderBy: { createdAt: 'desc' },
              take,
              include: { superAdmin: { select: { fullName: true } } },
            })
            .then((rows) =>
              rows.map((r) => ({
                id: `followup:${r.id}`,
                kind: 'followup' as const,
                at: r.createdAt.toISOString(),
                title: `Seguimiento: ${r.title}`,
                detail:
                  r.status === 'done'
                    ? 'Hecho'
                    : `Para el ${r.dueDate.toISOString().slice(0, 10).split('-').reverse().join('/')}`,
                actor: r.superAdmin?.fullName ?? null,
                link: null,
                tone: 'neutral' as const,
              })),
            )
        : none,
    ];

    const results = await Promise.all(sources);
    const all = results
      .flat()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
    const items = all.slice(0, limit);
    // Hay más si se ha cortado o si algún origen llegó a su tope de filas.
    const more = all.length > limit || results.some((r) => r.length >= take);
    const nextBefore = more ? (items[items.length - 1]?.at ?? null) : null;
    return { items, nextBefore };
  }
}
