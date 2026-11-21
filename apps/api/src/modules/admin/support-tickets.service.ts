import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  attachmentLabel,
  messageAttachmentsOf,
  replyAddressOf,
  SUPPORT_TICKET_REOPEN_DAYS,
  supportResponseTimeText,
  TICKET_WAITING_CLOSE_DAYS,
  TICKET_WAITING_REMINDER_DAYS,
  type MessageAttachmentDto,
  type MessageAttachmentInput,
  type MessageAttachmentUploadDto,
  type RateTicketInput,
  type SupportTeammateDto,
  type SupportTicketListFilter,
  type SupportTicketWatcherDto,
  type UpdateSupportTicketInput,
} from '@storageos/shared';

import {
  assertAttachments,
  attachmentsDto,
  requestAttachmentUpload,
} from '../../common/message-attachments';
import { pageArgs, toPage, type PageRequest } from '../../common/pagination';
import { UNANSWERED_ADMIN_MESSAGE } from '../../common/support-ticket-filters';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformService } from '../platform/platform.service';
import { realtimeChannels, RealtimeService } from '../realtime/realtime.service';

import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SupportAgilityService } from './support-agility.service';

import type { Env } from '../../config/env.schema';
import type {
  AddTicketMessageInput,
  AdminSupportTicketsPageDto,
  AssignTicketInput,
  CreateSupportTicketInput,
  PageDto,
  SupportTicketClosedReason,
  SupportTicketDto,
  SupportTicketMessageDto,
  SupportTicketPriorityValue,
  SupportTicketStatusValue,
  TransitionTicketInput,
} from '@storageos/shared';

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface TenantContext {
  tenantId: string;
  userId: string;
  meta?: RequestMeta;
  /**
   * Es el soporte de TrasterOS entrando en nombre de esta persona: no se
   * escribe lo que ha leído (lo leería el soporte, no ella).
   */
  impersonating?: boolean;
}

interface AdminContext {
  superAdminId: string;
  meta?: RequestMeta;
}

interface ListAdminFilters {
  search?: string;
  status?: SupportTicketStatusValue;
  priority?: SupportTicketPriorityValue;
  assignedAdminId?: string | null;
  tenantId?: string;
}

type TicketWithRelations = {
  id: string;
  tenantId: string;
  subject: string;
  status: SupportTicketStatusValue;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  category: string | null;
  createdByUserId: string | null;
  assignedAdminId: string | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  closedReason: string | null;
  firstResponseAt: Date | null;
  rating: number | null;
  ratingComment: string | null;
  replyToken: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
  screenSize?: string | null;
  aiAnswer?: string | null;
  createdAt: Date;
  updatedAt: Date;
  tenant: { name: string; slug: string };
  createdBy: { fullName: string } | null;
  assignedAdmin: { fullName: string } | null;
};

type MessageRow = {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  authorUserId: string | null;
  authorAdminId: string | null;
  attachmentKey: string | null;
  attachmentMime: string | null;
  attachmentName: string | null;
  extraAttachments: unknown;
  createdAt: Date;
  authorUser: { fullName: string } | null;
  authorAdmin: { fullName: string } | null;
};

/** Filtros de la lista del negocio (todos opcionales). */
export interface TenantTicketFilters {
  status?: SupportTicketListFilter | undefined;
  /** Solo los que abrió esta persona o en los que está en copia. */
  mine?: boolean | undefined;
  /** Texto en el asunto o en los mensajes. */
  search?: string | undefined;
}

const LIST_FILTER_STATUSES: Record<SupportTicketListFilter, SupportTicketStatusValue[]> = {
  open: ['open', 'in_progress'],
  waiting: ['waiting_user'],
  closed: ['resolved', 'closed'],
};

const PRIORITY_RANK: Record<SupportTicketPriorityValue, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

const PRIORITY_LABEL: Record<SupportTicketPriorityValue, string> = {
  low: 'baja',
  normal: 'normal',
  high: 'alta',
  urgent: 'urgente',
};

const DAY_MS = 86_400_000;

/** Tope de tickets nuevos por persona: cada uno avisa al soporte por panel y push. */
export const SUPPORT_TICKETS_PER_HOUR = 5;
export const SUPPORT_TICKETS_PER_DAY = 20;

const TICKET_INCLUDE = {
  tenant: { select: { name: true, slug: true } },
  createdBy: { select: { fullName: true } },
  assignedAdmin: { select: { fullName: true } },
} as const;

/** Cómo firma el soporte ante el negocio: «Ana · Soporte de TrasterOS». */
export function supportSignature(fullName: string | null | undefined): string {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? `${first} · Soporte de TrasterOS` : 'Soporte de TrasterOS';
}

const VALID_TRANSITIONS: Record<SupportTicketStatusValue, SupportTicketStatusValue[]> = {
  open: ['in_progress', 'waiting_user', 'resolved', 'closed'],
  in_progress: ['waiting_user', 'resolved', 'closed', 'open'],
  waiting_user: ['in_progress', 'resolved', 'closed', 'open'],
  resolved: ['closed', 'open'],
  closed: ['open'],
};

/**
 * Tickets de soporte: doble cara.
 *   - Tenant: ve/crea sus propios tickets via `/support/tickets` (RLS).
 *     Aqui filtramos por `tenantId` manualmente porque el cliente admin
 *     bypassa RLS; el guard tenant del controller garantiza que el
 *     `tenantId` viene del JWT.
 *   - Super admin: ve todos los tickets via `/admin/support/tickets`.
 *     Mensajes `isInternal=true` solo se devuelven en esta cara.
 */
@Injectable()
export class SupportTicketsService {
  private readonly logger = new Logger(SupportTicketsService.name);
  private readonly webBaseUrl: string;
  private readonly inboundDomain: string | undefined;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly platform: PlatformService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly agility: SupportAgilityService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true });
    this.inboundDomain = config.get('INBOUND_EMAIL_DOMAIN', { infer: true });
  }

  /** Avisa en vivo al panel del negocio y al del admin de que algo ha cambiado. */
  private async publish(tenantId: string, ticketId: string): Promise<void> {
    const event = { type: 'ticket' as const, ticketId };
    await Promise.all([
      this.realtime.publish(realtimeChannels.tenant(tenantId), event),
      this.realtime.publish(realtimeChannels.admin, event),
    ]);
  }

  // =========================== tenant facade ===============================

  /**
   * Respuestas de soporte que esta persona no ha leído, por ticket. Cuentan las
   * posteriores a su última lectura (o a su alta: quien entra nuevo no hereda
   * lo anterior). Un aviso del admin sin contestar se ve en «Mensajes de TrasterOS».
   */
  private async unreadByTicket(tenantId: string, userId: string): Promise<Map<string, number>> {
    const rows = await this.admin.$queryRaw<{ ticket_id: string; n: number }[]>`
      SELECT t.id AS ticket_id, count(*)::int AS n
      FROM support_tickets t
      JOIN support_ticket_messages m ON m.ticket_id = t.id
      LEFT JOIN support_ticket_reads r ON r.ticket_id = t.id AND r.user_id = ${userId}::uuid
      WHERE t.tenant_id = ${tenantId}::uuid
        AND t.status <> 'closed'
        AND m.is_internal = false
        AND m.author_user_id IS NULL
        AND m.created_at > COALESCE(
          r.last_read_at,
          (SELECT u.created_at FROM users u WHERE u.id = ${userId}::uuid)
        )
        AND NOT (
          t.opened_by_admin
          AND NOT EXISTS (
            SELECT 1 FROM support_ticket_messages x
            WHERE x.ticket_id = t.id AND x.author_user_id IS NOT NULL
          )
        )
      GROUP BY t.id`;
    return new Map(rows.map((r) => [r.ticket_id, r.n]));
  }

  /** Nº de tickets con una respuesta de soporte sin leer por esta persona — badge del menú. */
  async countWaitingForTenant(tenantId: string, userId: string): Promise<number> {
    return (await this.unreadByTicket(tenantId, userId)).size;
  }

  async listForTenant(tenantId: string, userId: string): Promise<SupportTicketDto[]> {
    const [rows, unread] = await Promise.all([
      this.admin.supportTicket.findMany({
        where: { tenantId },
        include: TICKET_INCLUDE,
        orderBy: { updatedAt: 'desc' },
      }),
      this.unreadByTicket(tenantId, userId),
    ]);
    return rows.map((r) => ({ ...this.tenantDto(r), unreadCount: unread.get(r.id) ?? 0 }));
  }

  /** Lo mismo por páginas (cursor = id del último ticket visto). */
  async pageForTenant(
    tenantId: string,
    userId: string,
    page: PageRequest,
    filters: TenantTicketFilters = {},
  ): Promise<PageDto<SupportTicketDto>> {
    const search = filters.search?.trim().slice(0, 100);
    const [rows, unread] = await Promise.all([
      this.admin.supportTicket.findMany({
        where: {
          tenantId,
          ...(filters.status ? { status: { in: LIST_FILTER_STATUSES[filters.status] } } : {}),
          ...(filters.mine
            ? {
                OR: [{ createdByUserId: userId }, { watchers: { some: { userId } } }],
              }
            : {}),
          ...(search
            ? {
                AND: [
                  {
                    OR: [
                      { subject: { contains: search, mode: 'insensitive' as const } },
                      {
                        messages: {
                          some: {
                            isInternal: false,
                            body: { contains: search, mode: 'insensitive' as const },
                          },
                        },
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
        include: TICKET_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(page),
      }),
      this.unreadByTicket(tenantId, userId),
    ]);
    const result = toPage(rows, page);
    return {
      items: result.items.map((r) => ({
        ...this.tenantDto(r),
        unreadCount: unread.get(r.id) ?? 0,
      })),
      nextCursor: result.nextCursor,
    };
  }

  /** Abrir el ticket lo deja leído para quien lo abre (no si es el soporte entrando en su nombre). */
  async detailForTenant(
    tenantId: string,
    ticketId: string,
    userId: string,
    opts: { impersonating?: boolean } = {},
  ): Promise<SupportTicketDto> {
    const ticket = await this.findForTenant(tenantId, ticketId);
    const [messages, watchers] = await Promise.all([
      this.loadMessages(ticketId, { includeInternal: false, forTenant: true }),
      this.loadWatchers(ticketId),
    ]);
    if (!opts.impersonating) await this.markTicketRead(tenantId, ticketId, userId);
    return { ...this.tenantDto(ticket), messages, watchers };
  }

  private async markTicketRead(tenantId: string, ticketId: string, userId: string): Promise<void> {
    const now = new Date();
    await this.admin.supportTicketRead.upsert({
      where: { ticketId_userId: { ticketId, userId } },
      create: { ticketId, userId, tenantId, lastReadAt: now },
      update: { lastReadAt: now },
    });
  }

  /** Corta la ráfaga de tickets: cada uno avisa al soporte por panel y push. */
  private async assertCanOpenTicket(userId: string): Promise<void> {
    const now = Date.now();
    const [lastHour, lastDay] = await Promise.all([
      this.admin.supportTicket.count({
        where: { createdByUserId: userId, createdAt: { gt: new Date(now - 3_600_000) } },
      }),
      this.admin.supportTicket.count({
        where: { createdByUserId: userId, createdAt: { gt: new Date(now - 86_400_000) } },
      }),
    ]);
    if (lastHour >= SUPPORT_TICKETS_PER_HOUR || lastDay >= SUPPORT_TICKETS_PER_DAY) {
      throw new HttpException(
        {
          code: 'too_many_tickets',
          message:
            lastHour >= SUPPORT_TICKETS_PER_HOUR
              ? `Has abierto ${SUPPORT_TICKETS_PER_HOUR} tickets en la última hora. Espera un poco o añade lo que falte en uno de los que ya tienes abiertos.`
              : `Has abierto ${SUPPORT_TICKETS_PER_DAY} tickets hoy. Añade lo que falte en uno de los que ya tienes abiertos o vuelve a intentarlo mañana.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async createForTenant(
    args: TenantContext & { input: CreateSupportTicketInput },
  ): Promise<SupportTicketDto> {
    await this.assertCanOpenTicket(args.userId);
    const attachment = await this.attachmentFields(args.tenantId, args.input);
    const watcherIds = await this.validWatcherIds(
      args.tenantId,
      args.input.watcherUserIds ?? [],
      args.userId,
    );
    const created = await this.admin.supportTicket.create({
      data: {
        tenantId: args.tenantId,
        createdByUserId: args.userId,
        subject: args.input.subject,
        priority: args.input.priority,
        category: args.input.category ? args.input.category : null,
        pageUrl: args.input.pageUrl ?? null,
        screenSize: args.input.screenSize ?? null,
        userAgent: args.meta?.userAgent?.slice(0, 500) ?? null,
        aiAnswer: args.input.aiAnswer?.trim() || null,
        status: 'open',
        ...(watcherIds.length > 0
          ? {
              watchers: {
                create: watcherIds.map((userId) => ({ userId, tenantId: args.tenantId })),
              },
            }
          : {}),
        messages: {
          create: {
            authorUserId: args.userId,
            body: args.input.body,
            isInternal: false,
            ...attachment,
          },
        },
      },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'support_ticket.created',
      entityType: 'SupportTicket',
      entityId: created.id,
      changes: { subject: created.subject, priority: created.priority },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    // Dejar constancia en el histórico de conversaciones del tenant, con enlace
    // al ticket para gestionarlo (best-effort; el ticket ya está creado).
    try {
      await this.interactions.create({
        tenantId: args.tenantId,
        superAdminId: null,
        input: {
          type: 'support',
          content: `Ticket de soporte abierto — ${args.input.subject}\n\n${args.input.body}`,
        },
        link: `/admin/support/${created.id}`,
      });
    } catch {
      /* el registro es secundario */
    }
    // Notificación en el feed del super admin.
    await this.platform.notify({
      type: 'support_ticket',
      title: `Nuevo ticket de ${created.tenant.name}`,
      body: args.input.subject,
      link: `/admin/support/${created.id}`,
    });
    // El resto del equipo lo ve en su lista sin recargar.
    await this.publish(args.tenantId, created.id);
    // Correo de «lo hemos recibido» a quien lo abre y a quien pone en copia.
    void this.sendCreatedMails(created as TicketWithRelations, watcherIds).catch((err) =>
      this.logger.warn(`[support] confirmación: ${(err as Error).message}`),
    );
    return this.tenantDto(created);
  }

  /** «Hemos recibido tu ticket» a quien lo abre; «te han puesto en copia» a los demás. */
  private async sendCreatedMails(ticket: TicketWithRelations, watcherIds: string[]): Promise<void> {
    const times = await this.agility.responseTimes();
    const eta = supportResponseTimeText(times.byPriority[ticket.priority].hours);
    if (ticket.createdByUserId) {
      const author = await this.admin.user.findFirst({
        where: { id: ticket.createdByUserId, isActive: true },
        select: { email: true, fullName: true },
      });
      if (author) {
        await this.sendTicketMail(ticket, author, {
          subject: `Hemos recibido tu ticket: ${ticket.subject}`,
          title: 'Hemos recibido tu ticket de soporte',
          body: `${eta}. Te avisaremos por correo y en el panel en cuanto te respondamos.`,
        });
      }
    }
    if (watcherIds.length === 0) return;
    const watchers = await this.admin.user.findMany({
      where: { id: { in: watcherIds }, isActive: true },
      select: { email: true, fullName: true },
    });
    const opener = ticket.createdBy?.fullName ?? 'Un compañero';
    for (const w of watchers) {
      await this.sendTicketMail(ticket, w, {
        subject: `Te han puesto en copia: ${ticket.subject}`,
        title: `${opener} ha abierto un ticket de soporte y te ha puesto en copia`,
        body: `Recibirás por correo las respuestas del soporte. ${eta}.`,
      });
    }
  }

  // ------------------------- reabrir, prioridad, copia ----------------------

  /** El negocio reabre un ticket cerrado (solo durante unos días tras el cierre). */
  async reopenAsTenant(args: TenantContext & { ticketId: string }): Promise<SupportTicketDto> {
    const ticket = await this.findForTenant(args.tenantId, args.ticketId);
    if (ticket.status !== 'closed') {
      throw new BadRequestException({
        code: 'ticket_not_closed',
        message: 'Solo se puede reabrir un ticket cerrado',
      });
    }
    if (!this.reopenableUntil(ticket)) {
      throw new BadRequestException({
        code: 'ticket_reopen_expired',
        message: `Han pasado más de ${SUPPORT_TICKET_REOPEN_DAYS} días desde que se cerró. Abre un ticket nuevo.`,
      });
    }
    const done = await this.admin.supportTicket.updateMany({
      where: { id: args.ticketId, status: 'closed' },
      data: {
        status: 'open',
        closedAt: null,
        closedReason: null,
        resolvedAt: null,
        waitingRemindedAt: null,
      },
    });
    if (done.count === 0)
      return this.tenantDto(await this.findForTenant(args.tenantId, args.ticketId));
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'support_ticket.reopened',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: { closedReason: ticket.closedReason },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    await this.platform.notify({
      type: 'support_ticket',
      title: `${ticket.tenant.name} reabre un ticket cerrado`,
      body: ticket.subject,
      link: `/admin/support/${args.ticketId}`,
    });
    await this.publish(args.tenantId, args.ticketId);
    return this.tenantDto(await this.findForTenant(args.tenantId, args.ticketId));
  }

  /** El negocio cambia la prioridad mientras el ticket no esté cerrado. */
  async updateAsTenant(
    args: TenantContext & { ticketId: string; input: UpdateSupportTicketInput },
  ): Promise<SupportTicketDto> {
    const ticket = await this.findForTenant(args.tenantId, args.ticketId);
    if (ticket.status === 'closed') {
      throw new BadRequestException({
        code: 'ticket_closed',
        message: 'No se puede cambiar un ticket cerrado',
      });
    }
    const next = args.input.priority;
    if (next === ticket.priority) return this.tenantDto(ticket);
    await this.admin.supportTicket.update({
      where: { id: args.ticketId },
      data: { priority: next },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'support_ticket.priority_changed',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: { from: ticket.priority, to: next },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    // Subir a alta o urgente avisa al soporte; bajarla no hace falta.
    if (PRIORITY_RANK[next] > PRIORITY_RANK[ticket.priority] && PRIORITY_RANK[next] >= 2) {
      await this.platform.notify({
        type: 'support_ticket',
        title: `${ticket.tenant.name} sube un ticket a prioridad ${PRIORITY_LABEL[next]}`,
        body: ticket.subject,
        link: `/admin/support/${args.ticketId}`,
      });
    }
    await this.publish(args.tenantId, args.ticketId);
    return this.tenantDto(await this.findForTenant(args.tenantId, args.ticketId));
  }

  /** Compañeros activos del negocio que se pueden poner en copia. */
  async listTeammates(tenantId: string, userId: string): Promise<SupportTeammateDto[]> {
    const rows = await this.admin.user.findMany({
      where: { tenantId, isActive: true, id: { not: userId } },
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: 'asc' },
      take: 200,
    });
    return rows;
  }

  /** Sustituye la lista de compañeros en copia (los nuevos reciben un correo). */
  async setWatchersAsTenant(
    args: TenantContext & { ticketId: string; userIds: string[] },
  ): Promise<SupportTicketWatcherDto[]> {
    const ticket = await this.findForTenant(args.tenantId, args.ticketId);
    const ids = await this.validWatcherIds(
      args.tenantId,
      args.userIds,
      ticket.createdByUserId ?? args.userId,
    );
    const before = await this.admin.supportTicketWatcher.findMany({
      where: { ticketId: args.ticketId },
      select: { userId: true },
    });
    const had = new Set(before.map((w) => w.userId));
    const added = ids.filter((id) => !had.has(id));
    await this.admin.$transaction([
      this.admin.supportTicketWatcher.deleteMany({
        where: { ticketId: args.ticketId, userId: { notIn: ids } },
      }),
      this.admin.supportTicketWatcher.createMany({
        data: added.map((userId) => ({ ticketId: args.ticketId, userId, tenantId: args.tenantId })),
        skipDuplicates: true,
      }),
    ]);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'support_ticket.watchers_changed',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: { userIds: ids },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    if (added.length > 0) {
      const people = await this.admin.user.findMany({
        where: { id: { in: added }, isActive: true },
        select: { email: true, fullName: true },
      });
      const who = await this.admin.user.findUnique({
        where: { id: args.userId },
        select: { fullName: true },
      });
      await this.replyAddress(ticket).catch(() => null);
      for (const p of people) {
        void this.sendTicketMail(ticket, p, {
          subject: `Te han puesto en copia: ${ticket.subject}`,
          title: `${who?.fullName ?? 'Un compañero'} te ha puesto en copia de un ticket de soporte`,
          body: 'Recibirás por correo las respuestas del soporte.',
        }).catch((err) => this.logger.warn(`[support] copia: ${(err as Error).message}`));
      }
    }
    return this.loadWatchers(args.ticketId);
  }

  /** Solo usuarios activos del mismo negocio; sin repetir ni incluir a quien lo abre. */
  private async validWatcherIds(
    tenantId: string,
    userIds: string[],
    excludeUserId: string,
  ): Promise<string[]> {
    const wanted = [...new Set(userIds)].filter((id) => id !== excludeUserId);
    if (wanted.length === 0) return [];
    const rows = await this.admin.user.findMany({
      where: { id: { in: wanted }, tenantId, isActive: true },
      select: { id: true },
    });
    if (rows.length !== wanted.length) {
      throw new BadRequestException({
        code: 'invalid_watchers',
        message: 'Solo puedes poner en copia a personas activas de tu equipo',
      });
    }
    return wanted;
  }

  private async loadWatchers(ticketId: string): Promise<SupportTicketWatcherDto[]> {
    const rows = await this.admin.supportTicketWatcher.findMany({
      where: { ticketId },
      include: { user: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ userId: r.userId, fullName: r.user.fullName, email: r.user.email }));
  }

  async addMessageAsTenant(
    args: TenantContext & {
      ticketId: string;
      input: AddTicketMessageInput;
    },
  ): Promise<SupportTicketMessageDto> {
    const ticket = await this.findForTenant(args.tenantId, args.ticketId);
    if (ticket.status === 'closed') {
      throw new BadRequestException({
        code: 'ticket_closed',
        message: 'No se puede añadir mensajes a un ticket cerrado',
      });
    }
    // El tenant NO puede crear mensajes internos.
    if (args.input.isInternal) {
      throw new ForbiddenException({
        code: 'internal_messages_forbidden',
        message: 'Solo los administradores pueden crear notas internas',
      });
    }
    const attachment = await this.attachmentFields(args.tenantId, args.input);
    const message = await this.admin.supportTicketMessage.create({
      data: {
        ticketId: args.ticketId,
        authorUserId: args.userId,
        body: args.input.body,
        isInternal: false,
        ...attachment,
      },
      include: {
        authorUser: { select: { fullName: true } },
        authorAdmin: { select: { fullName: true } },
      },
    });
    // Quien contesta ya ha leído lo anterior (el soporte en su nombre, no).
    if (!args.impersonating) await this.markTicketRead(args.tenantId, args.ticketId, args.userId);
    // Si el ticket estaba esperando al cliente, en curso o resuelto, vuelve a
    // open: la pelota pasa al admin (en curso se quedaba sin aviso alguno).
    if (
      ticket.status === 'waiting_user' ||
      ticket.status === 'in_progress' ||
      ticket.status === 'resolved'
    ) {
      await this.admin.supportTicket.update({
        where: { id: args.ticketId },
        data: { status: 'open' },
      });
    } else {
      // touch updatedAt para que aparezca arriba en la lista.
      await this.admin.supportTicket.update({
        where: { id: args.ticketId },
        data: { updatedAt: new Date() },
      });
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'support_ticket.message_added',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: { messageId: message.id },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    // El admin se entera de que el tenant ha contestado (feed + push).
    await this.platform.notify({
      type: 'support_ticket',
      title:
        ticket.status === 'resolved'
          ? `${ticket.tenant.name} reabre un ticket resuelto`
          : `Respuesta de ${ticket.tenant.name}`,
      body: `${ticket.subject}: ${this.preview(args.input)}`,
      link: `/admin/support/${args.ticketId}`,
    });
    await this.publish(args.tenantId, args.ticketId);
    return await this.toMessageDto(message, { forTenant: true });
  }

  /** El tenant da el ticket por terminado. */
  async closeAsTenant(args: TenantContext & { ticketId: string }): Promise<SupportTicketDto> {
    const ticket = await this.findForTenant(args.tenantId, args.ticketId);
    if (ticket.status === 'closed') return this.tenantDto(ticket);
    const updated = await this.admin.supportTicket.update({
      where: { id: args.ticketId },
      data: { status: 'closed', closedAt: new Date(), closedReason: 'tenant' },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'support_ticket.closed_by_tenant',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: { from: ticket.status },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    await this.platform.notify({
      type: 'support_ticket',
      title: `${ticket.tenant.name} ha cerrado un ticket`,
      body: ticket.subject,
      link: `/admin/support/${args.ticketId}`,
    });
    await this.publish(args.tenantId, args.ticketId);
    return this.tenantDto(updated as TicketWithRelations);
  }

  /** Valoración del tenant, una vez resuelto o cerrado. */
  async rateAsTenant(
    args: TenantContext & { ticketId: string; input: RateTicketInput },
  ): Promise<SupportTicketDto> {
    const ticket = await this.findForTenant(args.tenantId, args.ticketId);
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      throw new BadRequestException({
        code: 'ticket_not_finished',
        message: 'Se puede valorar cuando el ticket esté resuelto',
      });
    }
    if (ticket.rating !== null) {
      throw new ConflictException({ code: 'ticket_already_rated', message: 'Ya lo has valorado' });
    }
    // Sin una respuesta del soporte no hay atención que valorar.
    const answered = await this.admin.supportTicketMessage.count({
      where: { ticketId: args.ticketId, isInternal: false, authorAdminId: { not: null } },
    });
    if (answered === 0) {
      throw new BadRequestException({
        code: 'ticket_not_answered',
        message: 'Se puede valorar cuando el soporte haya respondido en el ticket',
      });
    }
    const updated = await this.admin.supportTicket.update({
      where: { id: args.ticketId },
      data: {
        rating: args.input.score,
        ratingComment: args.input.comment?.trim() || null,
        ratedAt: new Date(),
      },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    if (args.input.score <= 2) {
      await this.platform.notify({
        type: 'support_ticket.low_rating',
        title: `${ticket.tenant.name} ha valorado un ticket con ${args.input.score} de 5`,
        body: args.input.comment?.slice(0, 200) ?? ticket.subject,
        link: `/admin/support/${args.ticketId}`,
      });
    }
    return this.tenantDto(updated as TicketWithRelations);
  }

  /**
   * Tickets que esperan al tenant: a los días se le recuerda y, si sigue sin
   * contestar, se cierran. Los avisos del admin sin contestar van por su lado.
   */
  async remindWaiting(now = new Date()): Promise<{ reminded: number; closed: number }> {
    const include = {
      tenant: { select: { name: true, slug: true } },
      createdBy: { select: { fullName: true } },
      assignedAdmin: { select: { fullName: true } },
    };
    const day = 86_400_000;
    const stale = await this.admin.supportTicket.findMany({
      where: {
        status: 'waiting_user',
        NOT: UNANSWERED_ADMIN_MESSAGE,
        updatedAt: { lt: new Date(now.getTime() - TICKET_WAITING_REMINDER_DAYS * day) },
      },
      include,
      take: 500,
    });
    let reminded = 0;
    let closed = 0;
    for (const ticket of stale as (TicketWithRelations & { waitingRemindedAt: Date | null })[]) {
      if (!ticket.waitingRemindedAt) {
        const claimed = await this.admin.supportTicket.updateMany({
          where: { id: ticket.id, waitingRemindedAt: null },
          data: { waitingRemindedAt: now, updatedAt: ticket.updatedAt },
        });
        if (claimed.count === 0) continue;
        await this.noticeTenant(ticket, {
          title: 'Seguimos esperando tu respuesta',
          body: `Si no nos contestas, cerraremos el ticket en ${
            TICKET_WAITING_CLOSE_DAYS - TICKET_WAITING_REMINDER_DAYS
          } días.`,
        });
        reminded += 1;
        continue;
      }
      if (ticket.updatedAt.getTime() > now.getTime() - TICKET_WAITING_CLOSE_DAYS * day) continue;
      const done = await this.admin.supportTicket.updateMany({
        where: { id: ticket.id, status: 'waiting_user' },
        data: { status: 'closed', closedAt: now, closedReason: 'inactivity' },
      });
      if (done.count === 0) continue;
      await this.noticeTenant(ticket, {
        title: 'Hemos cerrado tu ticket de soporte',
        body: 'Como no hemos tenido respuesta, lo damos por terminado. Si lo necesitas, abre uno nuevo desde Soporte.',
      });
      closed += 1;
    }
    return { reminded, closed };
  }

  // ============================ admin facade ===============================

  /** Nº de tickets esperando respuesta del admin (cross-tenant) — badge del panel admin. */
  async countOpenForAdmin(): Promise<number> {
    return this.admin.supportTicket.count({
      where: { status: 'open', tenant: { deletedAt: null, status: { not: 'cancelled' } } },
    });
  }

  /**
   * Lista paginada por cursor (id del último ticket de la página). El orden es
   * estable gracias al desempate por `id`.
   */
  async listForAdmin(
    filters: ListAdminFilters,
    page: { cursor?: string; limit?: number } = {},
  ): Promise<AdminSupportTicketsPageDto> {
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 100);
    const rows = await this.admin.supportTicket.findMany({
      where: {
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.assignedAdminId !== undefined
          ? { assignedAdminId: filters.assignedAdminId }
          : {}),
        ...(filters.search
          ? {
              OR: [
                { subject: { contains: filters.search, mode: 'insensitive' } },
                { tenant: { name: { contains: filters.search, mode: 'insensitive' } } },
                { tenant: { slug: { contains: filters.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map((r) => this.toDto(r)),
      nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
    };
  }

  async detailForAdmin(ticketId: string): Promise<SupportTicketDto> {
    const ticket = await this.findForAdmin(ticketId);
    const [messages, watchers] = await Promise.all([
      this.loadMessages(ticketId, { includeInternal: true }),
      this.loadWatchers(ticketId),
    ]);
    return { ...this.toDto(ticket), messages, watchers };
  }

  async addMessageAsAdmin(
    args: AdminContext & {
      ticketId: string;
      input: AddTicketMessageInput;
    },
  ): Promise<SupportTicketMessageDto> {
    const ticket = await this.findForAdmin(args.ticketId);
    // En un ticket cerrado el tenant no puede contestar: primero hay que reabrirlo.
    if (ticket.status === 'closed' && !args.input.isInternal) {
      throw new BadRequestException({
        code: 'ticket_closed',
        message: 'Reabre el ticket para responder: el cliente no puede contestar en uno cerrado',
      });
    }
    const attachment = await this.attachmentFields(ticket.tenantId, args.input);
    const message = await this.admin.supportTicketMessage.create({
      data: {
        ticketId: args.ticketId,
        authorAdminId: args.superAdminId,
        body: args.input.body,
        isInternal: args.input.isInternal,
        ...attachment,
      },
      include: {
        authorUser: { select: { fullName: true } },
        authorAdmin: { select: { fullName: true } },
      },
    });
    // Si el admin responde (no interna) y el ticket estaba abierto o en curso,
    // lo movemos a waiting_user: la pelota esta en el cliente.
    const updates: {
      status?: SupportTicketStatusValue;
      updatedAt?: Date;
      firstResponseAt?: Date;
      waitingRemindedAt?: null;
    } = {
      updatedAt: new Date(),
      // Una respuesta nueva vuelve a contar los días de espera.
      ...(args.input.isInternal ? {} : { waitingRemindedAt: null }),
    };
    if (!args.input.isInternal && (ticket.status === 'open' || ticket.status === 'in_progress')) {
      updates.status = 'waiting_user';
    }
    // La primera respuesta visible para el cliente marca el tiempo de respuesta.
    if (!args.input.isInternal && !ticket.firstResponseAt) {
      updates.firstResponseAt = message.createdAt;
    }
    await this.admin.supportTicket.update({
      where: { id: args.ticketId },
      data: updates,
    });
    await this.audit.write({
      tenantId: ticket.tenantId,
      userId: null,
      action: args.input.isInternal
        ? 'support_ticket.internal_note_added'
        : 'support_ticket.admin_replied',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: { messageId: message.id, superAdminId: args.superAdminId },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    if (!args.input.isInternal) {
      await this.noticeTenant(ticket, {
        title: 'Soporte de TrasterOS te ha respondido',
        body: this.preview(args.input),
      });
      await this.publish(ticket.tenantId, args.ticketId);
    }
    return await this.toMessageDto(message);
  }

  async transition(
    args: AdminContext & {
      ticketId: string;
      input: TransitionTicketInput;
    },
  ): Promise<SupportTicketDto> {
    const ticket = await this.findForAdmin(args.ticketId);
    const allowed = VALID_TRANSITIONS[ticket.status];
    if (!allowed.includes(args.input.status)) {
      throw new BadRequestException({
        code: 'invalid_transition',
        message: `Transicion ${ticket.status} -> ${args.input.status} no permitida`,
      });
    }
    const now = new Date();
    const updated = await this.admin.supportTicket.update({
      where: { id: args.ticketId },
      data: {
        status: args.input.status,
        resolvedAt: args.input.status === 'resolved' ? now : ticket.resolvedAt,
        closedAt: args.input.status === 'closed' ? now : ticket.closedAt,
        // Al reabrirlo deja de estar cerrado por nadie.
        closedReason: args.input.status === 'closed' ? 'admin' : null,
      },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    await this.audit.write({
      tenantId: ticket.tenantId,
      userId: null,
      action: 'support_ticket.transitioned',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: {
        from: ticket.status,
        to: args.input.status,
        superAdminId: args.superAdminId,
      },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    if (args.input.status === 'resolved' || args.input.status === 'closed') {
      await this.noticeTenant(ticket, {
        title:
          args.input.status === 'resolved'
            ? 'Hemos resuelto tu ticket de soporte'
            : 'Hemos cerrado tu ticket de soporte',
        body:
          args.input.status === 'resolved'
            ? 'Si el problema sigue, responde en el ticket y lo reabriremos.'
            : 'Si necesitas algo más, abre un ticket nuevo desde Soporte.',
      });
    }
    await this.publish(ticket.tenantId, args.ticketId);
    return this.toDto(updated);
  }

  async assign(
    args: AdminContext & {
      ticketId: string;
      input: AssignTicketInput;
    },
  ): Promise<SupportTicketDto> {
    const ticket = await this.findForAdmin(args.ticketId);
    if (args.input.superAdminId) {
      const target = await this.admin.superAdmin.findUnique({
        where: { id: args.input.superAdminId },
      });
      if (!target || !target.isActive) {
        throw new NotFoundException({
          code: 'super_admin_not_found',
          message: 'Super admin no encontrado o desactivado',
        });
      }
    }
    const updated = await this.admin.supportTicket.update({
      where: { id: args.ticketId },
      data: { assignedAdminId: args.input.superAdminId },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    await this.audit.write({
      tenantId: ticket.tenantId,
      userId: null,
      action: 'support_ticket.assigned',
      entityType: 'SupportTicket',
      entityId: args.ticketId,
      changes: {
        previousAssignedAdminId: ticket.assignedAdminId,
        newAssignedAdminId: args.input.superAdminId,
        actorSuperAdminId: args.superAdminId,
      },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    if (args.input.superAdminId && args.input.superAdminId !== ticket.assignedAdminId) {
      await this.platform.notify({
        type: 'support_ticket.assigned',
        title: `Ticket asignado a ${updated.assignedAdmin?.fullName ?? 'un admin'}`,
        body: `${ticket.tenant.name}: ${ticket.subject}`,
        link: `/admin/support/${args.ticketId}`,
      });
    }
    return this.toDto(updated);
  }

  /** URL firmada para subir un adjunto a los tickets del tenant. */
  async requestAttachmentUpload(
    tenantId: string,
    mimeType: string,
  ): Promise<MessageAttachmentUploadDto> {
    return requestAttachmentUpload(this.files, `${tenantId}/support/`, mimeType);
  }

  /** Igual, desde el admin para un ticket concreto. */
  async requestAttachmentUploadAsAdmin(
    ticketId: string,
    mimeType: string,
  ): Promise<MessageAttachmentUploadDto> {
    const ticket = await this.findForAdmin(ticketId);
    return requestAttachmentUpload(this.files, `${ticket.tenantId}/support/`, mimeType);
  }

  private async attachmentFields(
    tenantId: string,
    input: {
      attachment?: MessageAttachmentInput | undefined;
      attachments?: MessageAttachmentInput[] | undefined;
    },
  ) {
    return assertAttachments(this.files, `${tenantId}/support/`, messageAttachmentsOf(input));
  }

  /** Texto del aviso: el mensaje o, si solo lleva adjunto, su nombre. */
  private preview(input: {
    body: string;
    attachment?: MessageAttachmentInput | undefined;
    attachments?: MessageAttachmentInput[] | undefined;
  }): string {
    const first = messageAttachmentsOf(input)[0];
    return (input.body || (first ? attachmentLabel(first.filename) : '')).slice(0, 140);
  }

  // ============================== helpers ==================================

  /**
   * Avisa al tenant de una respuesta o cambio del admin: notificación del panel
   * (y push) a todo el equipo, y correo a quien abrió el ticket. Best-effort:
   * un fallo del aviso no deshace la respuesta.
   */
  private async noticeTenant(
    ticket: TicketWithRelations,
    msg: { title: string; body: string },
  ): Promise<void> {
    const link = `/support/${ticket.id}`;
    try {
      await this.notifications.create(ticket.tenantId, {
        type: 'support.reply',
        title: msg.title,
        body: `${ticket.subject}: ${msg.body.slice(0, 140)}`,
        link,
      });
    } catch (err) {
      this.logger.warn(`[support] aviso in-app: ${(err as Error).message}`);
    }
    // Correo a quien lo abrió y a los compañeros en copia (una vez por dirección).
    const ids = [
      ...(ticket.createdByUserId ? [ticket.createdByUserId] : []),
      ...(
        await this.admin.supportTicketWatcher.findMany({
          where: { ticketId: ticket.id },
          select: { userId: true },
        })
      ).map((w) => w.userId),
    ];
    if (ids.length === 0) return;
    const people = await this.admin.user.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, email: true, fullName: true },
    });
    // La dirección de respuesta se fija antes de enviar en paralelo.
    await this.replyAddress(ticket).catch(() => null);
    const seen = new Set<string>();
    for (const person of people) {
      const key = person.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      void this.sendTicketMail(ticket, person, {
        subject: `${msg.title}: ${ticket.subject}`,
        title: `${msg.title} (ticket «${ticket.subject}»)`,
        body: msg.body,
      }).catch((err) => this.logger.warn(`[support] correo: ${(err as Error).message}`));
    }
  }

  /** Correo de un ticket con el enlace para verlo (y la dirección para responder, si hay). */
  private async sendTicketMail(
    ticket: TicketWithRelations,
    to: { email: string; fullName: string },
    msg: { subject: string; title: string; body: string },
  ): Promise<void> {
    const url = `${this.webBaseUrl}/support/${ticket.id}`;
    const replyTo = await this.replyAddress(ticket);
    const escape = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = [
      `Hola ${to.fullName},`,
      '',
      `${msg.title}:`,
      '',
      msg.body,
      '',
      replyTo
        ? `Puedes responder a este correo o entrar al ticket: ${url}`
        : `Ver el ticket y responder: ${url}`,
    ].join('\n');
    const html =
      `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">` +
      `<p>Hola ${escape(to.fullName)},</p>` +
      `<p>${escape(msg.title)}:</p>` +
      `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #2563eb;background:#f8fafc">${escape(msg.body).replace(/\n/g, '<br>')}</blockquote>` +
      `<p>${replyTo ? 'Puedes responder a este correo o ' : ''}<a href="${url}" style="color:#2563eb">${replyTo ? 'entrar al ticket' : 'Ver el ticket y responder'}</a></p></div>`;
    await this.email.sendRendered({
      to: to.email,
      kind: 'admin_message',
      subject: msg.subject,
      html,
      text,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    });
  }

  /** Dirección propia del ticket: lo que se conteste al correo vuelve a él. */
  private async replyAddress(ticket: TicketWithRelations): Promise<string | null> {
    if (!this.inboundDomain) return null;
    let token = ticket.replyToken;
    if (!token) {
      token = randomBytes(16).toString('hex');
      await this.admin.supportTicket.update({
        where: { id: ticket.id },
        data: { replyToken: token },
      });
      // Los siguientes correos del mismo aviso usan la misma dirección.
      ticket.replyToken = token;
    }
    return replyAddressOf('t', token, this.inboundDomain);
  }

  /** Quien contesta por correo: un usuario activo del negocio con ese email. */
  async addEmailReply(args: {
    token: string;
    from: string;
    body: string;
    attachments: MessageAttachmentInput[];
  }): Promise<boolean> {
    const ticket = await this.admin.supportTicket.findUnique({
      where: { replyToken: args.token },
      select: { id: true, tenantId: true },
    });
    if (!ticket) return false;
    const user = await this.admin.user.findFirst({
      where: {
        tenantId: ticket.tenantId,
        isActive: true,
        email: { equals: args.from, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (!user) return false;
    await this.addMessageAsTenant({
      tenantId: ticket.tenantId,
      userId: user.id,
      ticketId: ticket.id,
      input: { body: args.body, isInternal: false, attachments: args.attachments },
    });
    return true;
  }

  private async findForTenant(tenantId: string, ticketId: string): Promise<TicketWithRelations> {
    const row = await this.admin.supportTicket.findFirst({
      where: { id: ticketId, tenantId },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'ticket_not_found',
        message: 'Ticket no encontrado',
      });
    }
    return row as TicketWithRelations;
  }

  private async findForAdmin(ticketId: string): Promise<TicketWithRelations> {
    const row = await this.admin.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'ticket_not_found',
        message: 'Ticket no encontrado',
      });
    }
    return row as TicketWithRelations;
  }

  private async loadMessages(
    ticketId: string,
    opts: { includeInternal: boolean; forTenant?: boolean },
  ): Promise<SupportTicketMessageDto[]> {
    const rows = await this.admin.supportTicketMessage.findMany({
      where: {
        ticketId,
        ...(opts.includeInternal ? {} : { isInternal: false }),
      },
      include: {
        authorUser: { select: { fullName: true } },
        authorAdmin: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((r) => this.toMessageDto(r, { forTenant: opts.forTenant })));
  }

  private toDto(row: TicketWithRelations): SupportTicketDto {
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      tenantSlug: row.tenant.slug,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      category: row.category,
      createdByUserId: row.createdByUserId,
      createdByName: row.createdBy?.fullName ?? null,
      assignedAdminId: row.assignedAdminId,
      assignedAdminName: row.assignedAdmin?.fullName ?? null,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      closedReason: (row.closedReason as SupportTicketClosedReason | null) ?? null,
      firstResponseAt: row.firstResponseAt ? row.firstResponseAt.toISOString() : null,
      rating: row.rating,
      ratingComment: row.ratingComment,
      pageUrl: row.pageUrl ?? null,
      userAgent: row.userAgent ?? null,
      screenSize: row.screenSize ?? null,
      aiAnswer: row.aiAnswer ?? null,
      reopenableUntil: this.reopenableUntil(row)?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Un ticket cerrado se puede reabrir durante unos días (null si no está cerrado o ya pasaron). */
  private reopenableUntil(
    row: Pick<TicketWithRelations, 'status' | 'closedAt' | 'updatedAt'>,
    now = new Date(),
  ): Date | null {
    if (row.status !== 'closed') return null;
    const until = new Date(
      (row.closedAt ?? row.updatedAt).getTime() + SUPPORT_TICKET_REOPEN_DAYS * DAY_MS,
    );
    return until > now ? until : null;
  }

  /** Lo que ve el negocio: el soporte firma como «Ana · Soporte de TrasterOS». */
  private tenantDto(row: TicketWithRelations): SupportTicketDto {
    const dto = this.toDto(row);
    return {
      ...dto,
      assignedAdminName: dto.assignedAdminId ? supportSignature(dto.assignedAdminName) : null,
    };
  }

  private async toMessageDto(
    row: MessageRow,
    opts: { forTenant?: boolean | undefined } = {},
  ): Promise<SupportTicketMessageDto> {
    const attachments: MessageAttachmentDto[] = await attachmentsDto(this.files, row);
    const adminName = row.authorAdmin?.fullName ?? null;
    return {
      id: row.id,
      ticketId: row.ticketId,
      body: row.body,
      isInternal: row.isInternal,
      authorUserId: row.authorUserId,
      authorUserName: row.authorUser?.fullName ?? null,
      authorAdminId: row.authorAdminId,
      authorAdminName:
        opts.forTenant && row.authorAdminId ? supportSignature(adminName) : adminName,
      attachment: attachments[0] ?? null,
      attachments,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
