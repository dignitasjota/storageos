import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type CustomerNotifyPayload,
  type DomainEventPayload,
} from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  CustomerType,
  Incident,
  IncidentComment,
  IncidentSeverity,
  IncidentStatus,
  Prisma,
} from '@storageos/database';
import type {
  CreateIncidentInput,
  IncidentCommentDto,
  IncidentCommentInput,
  IncidentDto,
  IncidentSeverityValue,
  IncidentStatusValue,
  PortalIncidentDto,
  PortalReportIncidentInput,
  TransitionIncidentInput,
  UpdateIncidentInput,
} from '@storageos/shared';

interface ListFilters {
  status?: IncidentStatusValue;
  severity?: IncidentSeverityValue;
  facilityId?: string;
  unitId?: string;
  customerId?: string;
  contractId?: string;
  assignedToUserId?: string;
}

type IncidentWithIncludes = Incident & {
  facility?: { name: string } | null;
  unit?: { code: string } | null;
  customer?: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: CustomerType;
  } | null;
  contract?: { contractNumber: string } | null;
  assignedTo?: { fullName: string } | null;
  reportedBy?: { fullName: string } | null;
};

const INCLUDE = {
  facility: { select: { name: true } },
  unit: { select: { code: true } },
  customer: {
    select: {
      firstName: true,
      lastName: true,
      companyName: true,
      customerType: true,
    },
  },
  contract: { select: { contractNumber: true } },
  assignedTo: { select: { fullName: true } },
  reportedBy: { select: { fullName: true } },
} satisfies Prisma.IncidentInclude;

const ALLOWED_TRANSITIONS: Record<IncidentStatusValue, IncidentStatusValue[]> = {
  reported: ['investigating', 'resolved', 'dismissed'],
  investigating: ['resolved', 'dismissed', 'reported'],
  resolved: [],
  dismissed: ['reported'],
};

const HIGH_SEVERITY: ReadonlyArray<IncidentSeverityValue> = ['high', 'critical'];

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /** Nº de incidencias abiertas por estado (para los badges del menú). */
  async countOpenByStatus(tenantId: string): Promise<{ reported: number; investigating: number }> {
    return this.prisma.withTenant(async (tx) => {
      const [reported, investigating] = await Promise.all([
        tx.incident.count({ where: { tenantId, deletedAt: null, status: 'reported' } }),
        tx.incident.count({ where: { tenantId, deletedAt: null, status: 'investigating' } }),
      ]);
      return { reported, investigating };
    }, tenantId);
  }

  async list(tenantId: string, filters: ListFilters): Promise<IncidentDto[]> {
    const where: Prisma.IncidentWhereInput = { deletedAt: null };
    if (filters.status) where.status = filters.status as IncidentStatus;
    if (filters.severity) where.severity = filters.severity as IncidentSeverity;
    if (filters.facilityId) where.facilityId = filters.facilityId;
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.contractId) where.contractId = filters.contractId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.incident.findMany({
          where,
          include: INCLUDE,
          orderBy: [{ status: 'asc' }, { severity: 'desc' }, { createdAt: 'desc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r as IncidentWithIncludes));
  }

  async detail(tenantId: string, id: string): Promise<IncidentDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateIncidentInput;
    meta: RequestMeta;
  }): Promise<IncidentDto> {
    const data: Prisma.IncidentUncheckedCreateInput = {
      tenantId: args.tenantId,
      severity: args.input.severity,
      title: args.input.title,
      description: args.input.description || null,
      facilityId: args.input.facilityId ?? null,
      unitId: args.input.unitId ?? null,
      customerId: args.input.customerId ?? null,
      contractId: args.input.contractId ?? null,
      assignedToUserId: args.input.assignedToUserId ?? null,
      reportedByUserId: args.userId,
      occurredAt: args.input.occurredAt ? new Date(args.input.occurredAt) : null,
      metadata: args.input.metadata as Prisma.InputJsonValue,
    };
    const created = await this.prisma.withTenant(
      (tx) => tx.incident.create({ data, include: INCLUDE }),
      args.tenantId,
    );
    await this.writeAudit('incident.created', args, created.id);

    if (HIGH_SEVERITY.includes(created.severity as IncidentSeverityValue)) {
      const dto = this.toDto(created as IncidentWithIncludes);
      const payload: DomainEventPayload = {
        tenantId: args.tenantId,
        entityType: 'incident',
        entityId: created.id,
        recipientEmail: null,
        recipientPhone: null,
        scope: {
          incident: {
            id: dto.id,
            title: dto.title,
            description: dto.description ?? '',
            severity: dto.severity,
            status: dto.status,
            facilityId: dto.facilityId ?? '',
            facilityName: dto.facilityName ?? '',
            unitId: dto.unitId ?? '',
            unitCode: dto.unitCode ?? '',
            customerId: dto.customerId ?? '',
            customerName: dto.customerName ?? '',
            contractId: dto.contractId ?? '',
            contractNumber: dto.contractNumber ?? '',
            assignedToUserId: dto.assignedToUserId ?? '',
            assignedToName: dto.assignedToName ?? '',
            occurredAt: dto.occurredAt ?? '',
            createdAt: dto.createdAt,
          },
          tenant: { id: args.tenantId },
        },
      };
      this.events.emit(DOMAIN_EVENTS.incident_created, payload);
    }

    return this.toDto(created as IncidentWithIncludes);
  }

  /**
   * Alta de incidencia desde el portal del inquilino (sin usuario staff).
   * Siempre notifica al staff (emite `incident_created`).
   */
  async createFromPortal(args: {
    tenantId: string;
    customerId: string;
    input: PortalReportIncidentInput;
  }): Promise<PortalIncidentDto> {
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: args.customerId, tenantId: args.tenantId, deletedAt: null },
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        }),
      args.tenantId,
    );
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    const reporter =
      customer.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Inquilino';

    const created = await this.prisma.withTenant(
      (tx) =>
        tx.incident.create({
          data: {
            tenantId: args.tenantId,
            severity: 'medium',
            title: args.input.title,
            description: args.input.description || null,
            customerId: args.customerId,
            reportedByUserId: null,
            reportedByExternal: `Portal: ${reporter}`,
          },
          include: INCLUDE,
        }),
      args.tenantId,
    );

    const dto = this.toDto(created as IncidentWithIncludes);
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'incident',
      entityId: created.id,
      recipientEmail: null,
      recipientPhone: null,
      scope: {
        incident: {
          id: dto.id,
          title: dto.title,
          description: dto.description ?? '',
          severity: dto.severity,
          status: dto.status,
          facilityId: dto.facilityId ?? '',
          facilityName: dto.facilityName ?? '',
          unitId: dto.unitId ?? '',
          unitCode: dto.unitCode ?? '',
          customerId: dto.customerId ?? '',
          customerName: dto.customerName ?? '',
          contractId: dto.contractId ?? '',
          contractNumber: dto.contractNumber ?? '',
          assignedToUserId: dto.assignedToUserId ?? '',
          assignedToName: dto.assignedToName ?? '',
          occurredAt: dto.occurredAt ?? '',
          createdAt: dto.createdAt,
        },
        tenant: { id: args.tenantId },
      },
    };
    this.events.emit(DOMAIN_EVENTS.incident_created, payload);

    return this.toPortalDto(created);
  }

  /** Incidencias reportadas por un inquilino (para su portal). */
  async listForCustomer(tenantId: string, customerId: string): Promise<PortalIncidentDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.incident.findMany({
          where: { tenantId, customerId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            severity: true,
            createdAt: true,
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toPortalDto(r));
  }

  private toPortalDto(i: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    severity: string;
    createdAt: Date;
  }): PortalIncidentDto {
    return {
      id: i.id,
      title: i.title,
      description: i.description,
      status: i.status,
      severity: i.severity,
      createdAt: i.createdAt.toISOString(),
    };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateIncidentInput;
    meta: RequestMeta;
  }): Promise<IncidentDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.IncidentUncheckedUpdateInput = {};
    if (args.input.severity !== undefined) data.severity = args.input.severity;
    if (args.input.title !== undefined) data.title = args.input.title;
    if (args.input.description !== undefined) data.description = args.input.description || null;
    if (args.input.facilityId !== undefined) data.facilityId = args.input.facilityId ?? null;
    if (args.input.unitId !== undefined) data.unitId = args.input.unitId ?? null;
    if (args.input.customerId !== undefined) data.customerId = args.input.customerId ?? null;
    if (args.input.contractId !== undefined) data.contractId = args.input.contractId ?? null;
    if (args.input.assignedToUserId !== undefined)
      data.assignedToUserId = args.input.assignedToUserId ?? null;
    if (args.input.occurredAt !== undefined)
      data.occurredAt = args.input.occurredAt ? new Date(args.input.occurredAt) : null;
    if (args.input.metadata !== undefined)
      data.metadata = args.input.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) => tx.incident.update({ where: { id: args.id }, data, include: INCLUDE }),
      args.tenantId,
    );
    await this.writeAudit('incident.updated', args, args.id);
    return this.toDto(updated as IncidentWithIncludes);
  }

  async transition(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: TransitionIncidentInput;
    meta: RequestMeta;
  }): Promise<IncidentDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    const allowed = ALLOWED_TRANSITIONS[existing.status as IncidentStatusValue];
    if (!allowed.includes(args.input.status)) {
      throw new ConflictException({
        code: 'invalid_incident_transition',
        message: `No se puede pasar de ${existing.status} a ${args.input.status}`,
      });
    }
    const data: Prisma.IncidentUncheckedUpdateInput = { status: args.input.status };
    const now = new Date();
    if (args.input.status === 'resolved') {
      data.resolvedAt = now;
      if (args.input.resolution) data.resolution = args.input.resolution;
    }
    if (args.input.status === 'dismissed') {
      data.dismissedAt = now;
      if (args.input.resolution) data.resolution = args.input.resolution;
    }
    if (args.input.status === 'reported') {
      // Reabrir: limpiar timestamps de cierre.
      data.resolvedAt = null;
      data.dismissedAt = null;
    }
    const updated = await this.prisma.withTenant(
      (tx) => tx.incident.update({ where: { id: args.id }, data, include: INCLUDE }),
      args.tenantId,
    );
    await this.writeAudit(`incident.${args.input.status}`, args, args.id);
    // Cierra el loop: si la incidencia era de un inquilino, avísale por push de
    // la resolución (antes solo se enteraba entrando al portal).
    if (
      (args.input.status === 'resolved' || args.input.status === 'dismissed') &&
      updated.customerId
    ) {
      this.events.emit(DOMAIN_EVENTS.incident_resolved, {
        tenantId: args.tenantId,
        customerId: updated.customerId,
        title: args.input.status === 'resolved' ? 'Incidencia resuelta' : 'Incidencia cerrada',
        body: `Tu incidencia «${updated.title}» se ha ${
          args.input.status === 'resolved' ? 'resuelto' : 'cerrado'
        }.`,
        url: '/portal/login',
      } satisfies CustomerNotifyPayload);
    }
    return this.toDto(updated as IncidentWithIncludes);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id);
    await this.prisma.withTenant(
      (tx) => tx.incident.update({ where: { id: args.id }, data: { deletedAt: new Date() } }),
      args.tenantId,
    );
    await this.writeAudit('incident.deleted', args, args.id);
  }

  async listComments(tenantId: string, incidentId: string): Promise<IncidentCommentDto[]> {
    await this.findOrThrow(tenantId, incidentId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.incidentComment.findMany({
          where: { incidentId, deletedAt: null },
          include: { author: { select: { fullName: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      tenantId,
    );
    return rows.map((c) => this.commentToDto(c));
  }

  async addComment(args: {
    tenantId: string;
    userId: string;
    incidentId: string;
    input: IncidentCommentInput;
    meta: RequestMeta;
  }): Promise<IncidentCommentDto> {
    await this.findOrThrow(args.tenantId, args.incidentId);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.incidentComment.create({
          data: {
            tenantId: args.tenantId,
            incidentId: args.incidentId,
            authorUserId: args.userId,
            body: args.input.body,
          },
          include: { author: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.writeAudit('incident.comment_added', args, args.incidentId);
    return this.commentToDto(created);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<IncidentWithIncludes> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.incident.findFirst({
          where: { id, deletedAt: null },
          include: INCLUDE,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'incident_not_found',
        message: 'Incidencia no encontrada',
      });
    }
    return row as IncidentWithIncludes;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'Incident',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private resolveCustomerName(customer: IncidentWithIncludes['customer']): string | null {
    if (!customer) return null;
    if (customer.customerType === 'business') {
      return customer.companyName ?? null;
    }
    const parts = [customer.firstName ?? '', customer.lastName ?? '']
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(' ') : null;
  }

  private toDto(i: IncidentWithIncludes): IncidentDto {
    return {
      id: i.id,
      status: i.status as IncidentStatusValue,
      severity: i.severity as IncidentSeverityValue,
      title: i.title,
      description: i.description,
      facilityId: i.facilityId,
      facilityName: i.facility?.name ?? null,
      unitId: i.unitId,
      unitCode: i.unit?.code ?? null,
      customerId: i.customerId,
      customerName: this.resolveCustomerName(i.customer),
      contractId: i.contractId,
      contractNumber: i.contract?.contractNumber ?? null,
      assignedToUserId: i.assignedToUserId,
      assignedToName: i.assignedTo?.fullName ?? null,
      reportedByUserId: i.reportedByUserId,
      reportedByName: i.reportedBy?.fullName ?? null,
      reportedByExternal: i.reportedByExternal,
      occurredAt: i.occurredAt?.toISOString() ?? null,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      dismissedAt: i.dismissedAt?.toISOString() ?? null,
      resolution: i.resolution,
      metadata: (i.metadata ?? {}) as Record<string, unknown>,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }

  private commentToDto(
    c: IncidentComment & { author?: { fullName: string } | null },
  ): IncidentCommentDto {
    return {
      id: c.id,
      incidentId: c.incidentId,
      authorUserId: c.authorUserId,
      authorName: c.author?.fullName ?? null,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
