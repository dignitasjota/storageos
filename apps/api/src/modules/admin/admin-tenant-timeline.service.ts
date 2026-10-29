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
  'admin.tenant.ai_limit_changed': 'Asistente IA: límite o clave cambiados',
  'admin.tenant.operational_data_reset': 'Datos de prueba vaciados',
  'admin.tenant.quote_sent': 'Presupuesto enviado',
  'admin.approval.requested': 'Aprobación pedida por soporte',
  'admin.impersonation.revoked': 'Impersonación revocada',
  'admin.platform_sepa.item_bounced': 'Adeudo SEPA devuelto',
  'admin.saas_addon.trial_started': 'Prueba de un extra activada',
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

const NEGATIVE_ACTIONS = new Set([
  'admin.tenant.suspended',
  'admin.tenant.anonymized',
  'admin.tenant.operational_data_reset',
  'admin.platform_sepa.item_bounced',
]);

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
        ? // Se pagina por la misma fecha que se enseña (la del pago o, si no se
          // cobró, la del alta): un pago manual con fecha anterior no se pierde
          // ni se repite al cargar más.
          this.admin.$queryRaw<{ id: string }[]>`
            SELECT id FROM tenant_subscription_payments
            WHERE tenant_id = ${tenantId}::uuid AND COALESCE(paid_at, created_at) < ${before}
            ORDER BY COALESCE(paid_at, created_at) DESC
            LIMIT ${take}`
            .then((ids) =>
              ids.length
                ? this.admin.tenantSubscriptionPayment.findMany({
                    where: { id: { in: ids.map((r) => r.id) } },
                  })
                : [],
            )
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

    if (want('milestone')) sources.push(this.milestones(tenantId, before));

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

  /**
   * Hitos del propio tenant (alta, primer local, primer trastero, primer
   * inquilino, primer contrato firmado, primera factura, primer cobro a un
   * inquilino, certificado de la AEAT, dominio propio): su recorrido completo.
   */
  private async milestones(tenantId: string, before: Date): Promise<AdminTimelineItemDto[]> {
    const [tenant, facility, unit, customer, contract, invoice, payment, cert, owner] =
      await Promise.all([
        this.admin.tenant.findUnique({
          where: { id: tenantId },
          select: { createdAt: true, customDomain: true, customDomainVerifiedAt: true },
        }),
        this.admin.facility.aggregate({ where: { tenantId }, _min: { createdAt: true } }),
        this.admin.unit.aggregate({ where: { tenantId }, _min: { createdAt: true } }),
        this.admin.customer.aggregate({ where: { tenantId }, _min: { createdAt: true } }),
        this.admin.contract.aggregate({ where: { tenantId }, _min: { signedAt: true } }),
        this.admin.invoice.aggregate({
          where: { tenantId, kind: 'invoice', status: { notIn: ['draft', 'cancelled'] } },
          _min: { issueDate: true },
        }),
        this.admin.payment.aggregate({
          where: { tenantId, status: 'succeeded' },
          _min: { paidAt: true },
        }),
        this.admin.tenantAeatCredential.aggregate({
          where: { tenantId, ownerId: null },
          _min: { uploadedAt: true },
        }),
        this.admin.user.findFirst({
          where: { tenantId, role: 'owner', emailVerifiedAt: { not: null } },
          orderBy: { emailVerifiedAt: 'asc' },
          select: { emailVerifiedAt: true },
        }),
      ]);
    const raw: [string, string, Date | null | undefined][] = [
      ['signup', 'Alta en TrasterOS', tenant?.createdAt],
      ['verified', 'El propietario verificó su email', owner?.emailVerifiedAt],
      ['facility', 'Primer local creado', facility._min.createdAt],
      ['unit', 'Primer trastero creado', unit._min.createdAt],
      ['customer', 'Primer inquilino', customer._min.createdAt],
      ['contract', 'Primer contrato firmado', contract._min.signedAt],
      ['invoice', 'Primera factura emitida', invoice._min.issueDate],
      ['payment', 'Primer cobro a un inquilino', payment._min.paidAt],
      ['aeat', 'Certificado de la AEAT subido', cert._min?.uploadedAt],
      [
        'domain',
        `Dominio propio activo (${tenant?.customDomain ?? ''})`,
        tenant?.customDomainVerifiedAt,
      ],
    ];
    return raw
      .filter((r): r is [string, string, Date] => !!r[2] && r[2] < before)
      .map(([key, title, at]) => ({
        id: `milestone:${key}`,
        kind: 'milestone' as const,
        at: at.toISOString(),
        title,
        detail: null,
        actor: null,
        link: null,
        tone: 'positive' as const,
      }));
  }
}
