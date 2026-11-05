import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  attachmentLabel,
  DEFAULT_AUTO_REPLY,
  type BroadcastMessageInput,
  type ConversationContextDto,
  type ConversationStatsDto,
  type ConversationStatus,
  type CustomerCannedResponseDto,
  type InboxChannel,
  type InboxItemDto,
  type InboxPageDto,
  type MessageSettingsDto,
  type OpeningHours,
  type Permission,
  type UpdateConversationInput,
  type UpdateMessageSettingsInput,
  type UpsertCannedResponseInput,
} from '@storageos/shared';

import {
  customerScopeSql,
  customerScopeWhere,
  customerVisibilityFacilities,
} from '../../common/customer-scope';
import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailSuppressionsService } from '../email/email-suppressions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { realtimeChannels, RealtimeService } from '../realtime/realtime.service';

import { CustomerMessagesService } from './customer-messages.service';

import type { FacilityScope } from '../../common/facility-scope';

const INBOX_PAGE = 30;

interface InboxQuery {
  channel: InboxChannel;
  status?: ConversationStatus | undefined;
  mine: boolean;
  search?: string | undefined;
  facilityId?: string | undefined;
  cursor?: Date | undefined;
}

interface Viewer {
  tenantId: string;
  userId: string;
  scope: FacilityScope;
  permissions: Permission[] | undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const like = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

const customerDisplayName = (c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}) =>
  c.customerType === 'business'
    ? (c.companyName ?? 'Empresa')
    : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';

/**
 * Lo que rodea a los mensajes: estado y responsable de cada conversación, la
 * bandeja con todos los canales, respuestas guardadas, horario de atención y
 * tiempos de respuesta del equipo.
 */
@Injectable()
export class CustomerConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly messages: CustomerMessagesService,
    private readonly notifications: NotificationsService,
    private readonly suppressions: EmailSuppressionsService,
    private readonly realtime: RealtimeService,
  ) {}

  // --- Bandeja ---------------------------------------------------------------

  private async customerItems(v: Viewer, q: InboxQuery): Promise<InboxItemDto[]> {
    const search = q.search?.trim();
    const pattern = search ? like(search) : null;
    const rows = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<
        {
          customer_id: string;
          body: string;
          sender_type: string;
          channel: string;
          created_at: Date;
          attachment_name: string | null;
          customer_type: string;
          first_name: string | null;
          last_name: string | null;
          company_name: string | null;
          status: string | null;
          assigned_user_id: string | null;
          assigned_name: string | null;
          unread: number;
        }[]
      >`
        WITH last AS (
          SELECT DISTINCT ON (m.customer_id)
            m.customer_id, m.body, m.sender_type, m.channel, m.created_at, m.attachment_name
          FROM customer_messages m
          WHERE m.tenant_id = ${v.tenantId}::uuid AND NOT m.is_internal
          ORDER BY m.customer_id, m.created_at DESC, m.id DESC
        )
        SELECT l.*, c.customer_type::text AS customer_type, c.first_name, c.last_name,
          c.company_name, v.status, v.assigned_user_id, a.full_name AS assigned_name,
          (
            SELECT count(*)::int FROM customer_messages x
            WHERE x.tenant_id = ${v.tenantId}::uuid
              AND x.customer_id = l.customer_id
              AND x.sender_type = 'customer'
              AND x.created_at > COALESCE(
                (SELECT r.last_read_at FROM customer_message_reads r
                  WHERE r.customer_id = l.customer_id AND r.user_id = ${v.userId}::uuid),
                (SELECT u.created_at FROM users u WHERE u.id = ${v.userId}::uuid)
              )
          ) AS unread
        FROM last l
        JOIN customers c ON c.id = l.customer_id AND c.deleted_at IS NULL
        LEFT JOIN customer_conversations v ON v.customer_id = l.customer_id
        LEFT JOIN users a ON a.id = v.assigned_user_id
        WHERE ${customerScopeSql(Prisma.sql`l.customer_id`, v.scope)}
          AND (${q.cursor ?? null}::timestamptz IS NULL OR l.created_at < ${q.cursor ?? null}::timestamptz)
          AND (${q.status ?? null}::text IS NULL OR v.status = ${q.status ?? null}::text)
          AND (NOT ${q.mine} OR v.assigned_user_id = ${v.userId}::uuid)
          AND (${q.facilityId ?? null}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM contracts k
            JOIN units u ON u.id = k.unit_id
            WHERE k.customer_id = l.customer_id
              AND k.deleted_at IS NULL
              AND u.facility_id = ${q.facilityId ?? null}::uuid
          ))
          AND (${pattern}::text IS NULL
            OR concat_ws(' ', c.first_name, c.last_name, c.company_name, c.email, c.phone)
              ILIKE ${pattern}::text
            OR EXISTS (
              SELECT 1 FROM customer_messages b
              WHERE b.customer_id = l.customer_id AND b.body ILIKE ${pattern}::text
            ))
        ORDER BY l.created_at DESC
        LIMIT ${INBOX_PAGE}`,
      v.tenantId,
    );
    return rows.map((r) => ({
      kind: 'customer',
      id: r.customer_id,
      name: customerDisplayName({
        customerType: r.customer_type,
        firstName: r.first_name,
        lastName: r.last_name,
        companyName: r.company_name,
      }),
      preview: (r.body || (r.attachment_name ? attachmentLabel(r.attachment_name) : '')).slice(
        0,
        200,
      ),
      fromStaff: r.sender_type === 'staff',
      channel: (r.channel ?? 'portal') as InboxItemDto['channel'],
      at: r.created_at.toISOString(),
      unread: r.unread,
      status: (r.status ?? 'pending') as ConversationStatus,
      assignedUserId: r.assigned_user_id,
      assignedUserName: r.assigned_name,
      href: null,
    }));
  }

  private async whatsappItems(v: Viewer, q: InboxQuery): Promise<InboxItemDto[]> {
    const search = q.search?.trim();
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.whatsappConversation.findMany({
          where: {
            ...(q.cursor ? { lastMessageAt: { lt: q.cursor } } : {}),
            ...(v.scope
              ? {
                  OR: [{ customerId: null }, { customer: customerScopeWhere(v.scope) }],
                }
              : {}),
            ...(search
              ? {
                  AND: [
                    {
                      OR: [
                        { contactName: { contains: search, mode: 'insensitive' } },
                        { waId: { contains: search } },
                        { lastMessagePreview: { contains: search, mode: 'insensitive' } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          include: {
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
          orderBy: { lastMessageAt: 'desc' },
          take: INBOX_PAGE,
        }),
      v.tenantId,
    );
    return rows.map((c) => ({
      kind: 'whatsapp',
      id: c.id,
      name: c.customer ? customerDisplayName(c.customer) : (c.contactName ?? c.waId),
      preview: c.lastMessagePreview ?? '',
      fromStaff: false,
      channel: 'whatsapp',
      at: c.lastMessageAt.toISOString(),
      unread: c.unreadCount,
      status: null,
      assignedUserId: null,
      assignedUserName: null,
      href: `/whatsapp?c=${c.id}`,
    }));
  }

  private async webItems(v: Viewer, q: InboxQuery): Promise<InboxItemDto[]> {
    const search = q.search?.trim();
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.webChatConversation.findMany({
          where: {
            mode: 'human',
            ...(q.cursor ? { lastMessageAt: { lt: q.cursor } } : {}),
            ...(search
              ? { messages: { some: { content: { contains: search, mode: 'insensitive' } } } }
              : {}),
          },
          include: {
            lead: { select: { firstName: true, lastName: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } },
          },
          orderBy: { lastMessageAt: 'desc' },
          take: INBOX_PAGE,
        }),
      v.tenantId,
    );
    return rows.map((c) => ({
      kind: 'web',
      id: c.id,
      name:
        [c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(' ').trim() ||
        'Visitante de la web',
      preview: (c.messages[0]?.content ?? '').slice(0, 200),
      fromStaff: false,
      channel: null,
      at: c.lastMessageAt.toISOString(),
      unread: c.staffUnread,
      status: null,
      assignedUserId: null,
      assignedUserName: null,
      href: `/marketing/web-chat?c=${c.id}`,
    }));
  }

  async inbox(v: Viewer, q: InboxQuery): Promise<InboxPageDto> {
    const can = (p: Permission) => !v.permissions || v.permissions.includes(p);
    // Con filtros de estado o responsable solo cuentan las conversaciones con inquilinos.
    const customersOnly = q.status !== undefined || q.mine || q.facilityId !== undefined;
    const wantsWhatsapp =
      !customersOnly &&
      (q.channel === 'all' || q.channel === 'whatsapp') &&
      can('communications:read') &&
      (await tenantHasFeature(this.admin, v.tenantId, 'whatsapp_business'));
    const wantsWeb =
      !customersOnly &&
      (q.channel === 'all' || q.channel === 'web') &&
      can('marketing:read') &&
      (await tenantHasFeature(this.admin, v.tenantId, 'ai_assistant'));
    const [customers, whatsapp, web, counts] = await Promise.all([
      q.channel === 'all' || q.channel === 'customers' ? this.customerItems(v, q) : [],
      wantsWhatsapp ? this.whatsappItems(v, q) : [],
      wantsWeb ? this.webItems(v, q) : [],
      this.inboxCounts(v),
    ]);
    const all = [...customers, ...whatsapp, ...web].sort((a, b) => b.at.localeCompare(a.at));
    const items = all.slice(0, INBOX_PAGE);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        all.length > INBOX_PAGE || items.length === INBOX_PAGE ? (last?.at ?? null) : null,
      counts,
    };
  }

  private async inboxCounts(v: Viewer): Promise<InboxPageDto['counts']> {
    const where = {
      tenantId: v.tenantId,
      status: 'pending',
      customer: { deletedAt: null, ...customerScopeWhere(v.scope) },
    } satisfies Prisma.CustomerConversationWhereInput;
    const [pending, mine, unassigned] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.customerConversation.count({ where }),
          tx.customerConversation.count({ where: { ...where, assignedUserId: v.userId } }),
          tx.customerConversation.count({ where: { ...where, assignedUserId: null } }),
        ]),
      v.tenantId,
    );
    return { pending, mine, unassigned };
  }

  // --- Una conversación --------------------------------------------------------

  async context(tenantId: string, customerId: string): Promise<ConversationContextDto> {
    const data = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.customer.findFirst({
            where: { id: customerId, tenantId, deletedAt: null },
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              email: true,
              portalLastSeenAt: true,
            },
          }),
          tx.customerConversation.findUnique({
            where: { customerId },
            include: { assigned: { select: { fullName: true } } },
          }),
          tx.pushSubscription.count({ where: { customerId } }),
          tx.contract.findFirst({
            where: {
              customerId,
              deletedAt: null,
              status: { in: ['draft', 'active', 'ending'] },
            },
            orderBy: { createdAt: 'desc' },
            select: { unit: { select: { code: true, facility: { select: { name: true } } } } },
          }),
          tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        ]),
      tenantId,
    );
    const [customer, conversation, pushDevices, contract, tenant] = data;
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    const emailBlocked = customer.email
      ? (await this.suppressions.blockedForAll(customer.email)) !== null
      : false;
    return {
      status: (conversation?.status ?? 'answered') as ConversationStatus,
      assignedUserId: conversation?.assignedUserId ?? null,
      assignedUserName: conversation?.assigned?.fullName ?? null,
      reach: {
        email: customer.email,
        emailBlocked,
        portalLastSeenAt: customer.portalLastSeenAt?.toISOString() ?? null,
        pushDevices,
        unreachable:
          (!customer.email || emailBlocked) && !customer.portalLastSeenAt && pushDevices === 0,
      },
      variables: {
        nombre: customer.firstName ?? '',
        apellidos: customer.lastName ?? '',
        empresa: customer.companyName ?? '',
        trastero: contract?.unit.code ?? '',
        local: contract?.unit.facility.name ?? '',
        negocio: tenant?.name ?? '',
      },
    };
  }

  async update(
    tenantId: string,
    customerId: string,
    input: UpdateConversationInput,
    actorId: string,
  ): Promise<ConversationContextDto> {
    if (input.assignedUserId) {
      const user = await this.prisma.withTenant(
        (tx) =>
          tx.user.findFirst({
            where: { id: input.assignedUserId!, isActive: true },
            select: { id: true },
          }),
        tenantId,
      );
      if (!user) {
        throw new BadRequestException({
          code: 'invalid_assignee',
          message: 'Esa persona no está en tu equipo',
        });
      }
    }
    const before = await this.prisma.withTenant(async (tx) => {
      const current = await tx.customerConversation.findUnique({ where: { customerId } });
      const data = {
        ...(input.status
          ? { status: input.status, closedAt: input.status === 'closed' ? new Date() : null }
          : {}),
        ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
      };
      await tx.customerConversation.upsert({
        where: { customerId },
        create: { customerId, tenantId, ...data },
        update: data,
      });
      return current;
    }, tenantId);
    const assigned = input.assignedUserId;
    if (assigned && assigned !== before?.assignedUserId && assigned !== actorId) {
      const context = await this.context(tenantId, customerId);
      const name = [context.variables.nombre, context.variables.apellidos]
        .filter(Boolean)
        .join(' ');
      await this.notifications.create(tenantId, {
        type: 'customer.conversation_assigned',
        title: 'Te han asignado una conversación',
        ...(name ? { body: name } : {}),
        link: `/messages?c=${customerId}`,
        userId: assigned,
      });
    }
    await this.realtime.publish(realtimeChannels.tenant(tenantId), {
      type: 'conversation',
      customerId,
      facilityIds: await customerVisibilityFacilities(this.admin, tenantId, customerId),
    });
    return this.context(tenantId, customerId);
  }

  /** El mismo mensaje en el hilo de cada inquilino que la persona puede ver. */
  async broadcast(
    tenantId: string,
    userId: string,
    scope: FacilityScope,
    input: BroadcastMessageInput,
  ): Promise<{ sent: number; skipped: number }> {
    const visible = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: { id: { in: input.customerIds }, deletedAt: null, ...customerScopeWhere(scope) },
          select: { id: true },
        }),
      tenantId,
    );
    let sent = 0;
    for (const { id } of visible) {
      await this.messages.sendFromStaff(tenantId, id, userId, input.body);
      sent += 1;
    }
    return { sent, skipped: input.customerIds.length - sent };
  }

  // --- Respuestas guardadas ----------------------------------------------------

  async listCanned(tenantId: string): Promise<CustomerCannedResponseDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.customerCannedResponse.findMany({ orderBy: { title: 'asc' } }),
      tenantId,
    );
    return rows.map(({ id, title, body }) => ({ id, title, body }));
  }

  async createCanned(
    tenantId: string,
    input: UpsertCannedResponseInput,
  ): Promise<CustomerCannedResponseDto> {
    const { id, title, body } = await this.prisma.withTenant(
      (tx) => tx.customerCannedResponse.create({ data: { tenantId, ...input } }),
      tenantId,
    );
    return { id, title, body };
  }

  async updateCanned(
    tenantId: string,
    id: string,
    input: UpsertCannedResponseInput,
  ): Promise<CustomerCannedResponseDto> {
    const res = await this.prisma.withTenant(
      (tx) => tx.customerCannedResponse.updateMany({ where: { id }, data: input }),
      tenantId,
    );
    if (res.count === 0) throw new NotFoundException({ code: 'canned_response_not_found' });
    return { id, ...input };
  }

  async deleteCanned(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.customerCannedResponse.deleteMany({ where: { id } }),
      tenantId,
    );
  }

  // --- Horario de atención -----------------------------------------------------

  async settings(tenantId: string): Promise<MessageSettingsDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { messageHours: true, messageAutoReply: true, messageAutoReplyEnabled: true },
    });
    return {
      autoReplyEnabled: tenant?.messageAutoReplyEnabled ?? false,
      autoReply: tenant?.messageAutoReply || DEFAULT_AUTO_REPLY,
      hours: (tenant?.messageHours as OpeningHours | null) ?? null,
    };
  }

  async updateSettings(
    tenantId: string,
    input: UpdateMessageSettingsInput,
  ): Promise<MessageSettingsDto> {
    if (input.autoReplyEnabled && !input.hours) {
      throw new BadRequestException({
        code: 'message_hours_required',
        message: 'Indica tu horario de atención',
      });
    }
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        messageAutoReplyEnabled: input.autoReplyEnabled,
        messageAutoReply: input.autoReply?.trim() || null,
        ...(input.hours ? { messageHours: input.hours } : {}),
      },
    });
    return this.settings(tenantId);
  }

  // --- Tiempos de respuesta ----------------------------------------------------

  async stats(tenantId: string, scope: FacilityScope, days: number): Promise<ConversationStatsDto> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<{ user_id: string | null; name: string | null; seconds: number }[]>`
        WITH seq AS (
          SELECT m.id, m.customer_id, m.sender_type, m.sender_user_id, m.created_at,
            LAG(m.sender_type) OVER w AS prev_type
          FROM customer_messages m
          WHERE m.tenant_id = ${tenantId}::uuid
            AND m.created_at >= ${since}
            AND NOT m.is_internal
            AND NOT m.is_auto
            AND ${customerScopeSql(Prisma.sql`m.customer_id`, scope)}
          WINDOW w AS (PARTITION BY m.customer_id ORDER BY m.created_at, m.id)
        ), runs AS (
          SELECT s.*, MAX(
            CASE WHEN s.sender_type = 'customer' AND s.prev_type IS DISTINCT FROM 'customer'
              THEN s.created_at END
          ) OVER (PARTITION BY s.customer_id ORDER BY s.created_at, s.id) AS run_start
          FROM seq s
        )
        SELECT r.sender_user_id AS user_id, u.full_name AS name,
          EXTRACT(EPOCH FROM r.created_at - r.run_start)::float AS seconds
        FROM runs r
        LEFT JOIN users u ON u.id = r.sender_user_id
        WHERE r.sender_type = 'staff' AND r.prev_type = 'customer' AND r.run_start IS NOT NULL`,
      tenantId,
    );
    const minutes = rows.map((r) => r.seconds / 60);
    const byPerson = new Map<string, { name: string; minutes: number[]; id: string | null }>();
    for (const r of rows) {
      const key = r.user_id ?? 'none';
      const entry = byPerson.get(key) ?? {
        id: r.user_id,
        name: r.name ?? 'Sin identificar',
        minutes: [],
      };
      entry.minutes.push(r.seconds / 60);
      byPerson.set(key, entry);
    }
    const { pending } = await this.inboxCounts({
      tenantId,
      userId: '00000000-0000-0000-0000-000000000000',
      scope,
      permissions: undefined,
    });
    const middle = median(minutes);
    return {
      days,
      answered: rows.length,
      medianMinutes: middle === null ? null : Math.round(middle),
      withinHourPct:
        rows.length === 0
          ? null
          : Math.round((minutes.filter((m) => m <= 60).length / rows.length) * 100),
      pending,
      byPerson: [...byPerson.values()]
        .map((p) => ({
          userId: p.id,
          name: p.name,
          answered: p.minutes.length,
          medianMinutes: Math.round(median(p.minutes) ?? 0),
        }))
        .sort((a, b) => b.answered - a.answered),
    };
  }
}
