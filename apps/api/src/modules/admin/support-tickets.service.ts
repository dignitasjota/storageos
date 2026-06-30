import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';

import type {
  AddTicketMessageInput,
  AssignTicketInput,
  CreateSupportTicketInput,
  SupportTicketDto,
  SupportTicketMessageDto,
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
}

interface AdminContext {
  superAdminId: string;
  meta?: RequestMeta;
}

interface ListAdminFilters {
  search?: string;
  status?: SupportTicketStatusValue;
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
  createdAt: Date;
  authorUser: { fullName: string } | null;
  authorAdmin: { fullName: string } | null;
};

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
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly interactions: AdminTenantInteractionsService,
  ) {}

  // =========================== tenant facade ===============================

  /** Nº de tickets esperando respuesta del tenant (el admin ya contestó) — badge del menú. */
  async countWaitingForTenant(tenantId: string): Promise<number> {
    return this.admin.supportTicket.count({ where: { tenantId, status: 'waiting_user' } });
  }

  async listForTenant(tenantId: string): Promise<SupportTicketDto[]> {
    const rows = await this.admin.supportTicket.findMany({
      where: { tenantId },
      include: {
        tenant: { select: { name: true, slug: true } },
        createdBy: { select: { fullName: true } },
        assignedAdmin: { select: { fullName: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async detailForTenant(tenantId: string, ticketId: string): Promise<SupportTicketDto> {
    const ticket = await this.findForTenant(tenantId, ticketId);
    const messages = await this.loadMessages(ticketId, { includeInternal: false });
    return { ...this.toDto(ticket), messages };
  }

  async createForTenant(
    args: TenantContext & { input: CreateSupportTicketInput },
  ): Promise<SupportTicketDto> {
    const created = await this.admin.supportTicket.create({
      data: {
        tenantId: args.tenantId,
        createdByUserId: args.userId,
        subject: args.input.subject,
        priority: args.input.priority,
        category: args.input.category ? args.input.category : null,
        status: 'open',
        messages: {
          create: {
            authorUserId: args.userId,
            body: args.input.body,
            isInternal: false,
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
    return this.toDto(created);
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
    const message = await this.admin.supportTicketMessage.create({
      data: {
        ticketId: args.ticketId,
        authorUserId: args.userId,
        body: args.input.body,
        isInternal: false,
      },
      include: {
        authorUser: { select: { fullName: true } },
        authorAdmin: { select: { fullName: true } },
      },
    });
    // Si el ticket estaba en waiting_user, vuelve a open (el cliente respondio).
    if (ticket.status === 'waiting_user') {
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
    return this.toMessageDto(message);
  }

  // ============================ admin facade ===============================

  /** Nº de tickets esperando respuesta del admin (cross-tenant) — badge del panel admin. */
  async countOpenForAdmin(): Promise<number> {
    return this.admin.supportTicket.count({ where: { status: 'open' } });
  }

  async listForAdmin(filters: ListAdminFilters): Promise<SupportTicketDto[]> {
    const rows = await this.admin.supportTicket.findMany({
      where: {
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
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
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  async detailForAdmin(ticketId: string): Promise<SupportTicketDto> {
    const ticket = await this.findForAdmin(ticketId);
    const messages = await this.loadMessages(ticketId, { includeInternal: true });
    return { ...this.toDto(ticket), messages };
  }

  async addMessageAsAdmin(
    args: AdminContext & {
      ticketId: string;
      input: AddTicketMessageInput;
    },
  ): Promise<SupportTicketMessageDto> {
    const ticket = await this.findForAdmin(args.ticketId);
    const message = await this.admin.supportTicketMessage.create({
      data: {
        ticketId: args.ticketId,
        authorAdminId: args.superAdminId,
        body: args.input.body,
        isInternal: args.input.isInternal,
      },
      include: {
        authorUser: { select: { fullName: true } },
        authorAdmin: { select: { fullName: true } },
      },
    });
    // Si el admin responde (no interna) y el ticket estaba open, lo movemos
    // a waiting_user para reflejar que la pelota esta en el cliente.
    const updates: { status?: SupportTicketStatusValue; updatedAt?: Date } = {
      updatedAt: new Date(),
    };
    if (!args.input.isInternal && ticket.status === 'open') {
      updates.status = 'waiting_user';
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
    return this.toMessageDto(message);
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
    return this.toDto(updated);
  }

  // ============================== helpers ==================================

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
    opts: { includeInternal: boolean },
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
    return rows.map((r) => this.toMessageDto(r));
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toMessageDto(row: MessageRow): SupportTicketMessageDto {
    return {
      id: row.id,
      ticketId: row.ticketId,
      body: row.body,
      isInternal: row.isInternal,
      authorUserId: row.authorUserId,
      authorUserName: row.authorUser?.fullName ?? null,
      authorAdminId: row.authorAdminId,
      authorAdminName: row.authorAdmin?.fullName ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
