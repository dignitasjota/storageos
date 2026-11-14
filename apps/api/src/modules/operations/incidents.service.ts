import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { assertFacilityAllowed, optionalFacilityWhere } from '../../common/facility-scope';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type CustomerNotifyPayload,
  type DomainEventPayload,
} from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

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
  ChecklistItemDto,
  CreateIncidentInput,
  IncidentCommentDto,
  IncidentContextDto,
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
  /** Locales del usuario (null = todos). */
  facilityScope?: string[] | null;
  /** Título de la incidencia. */
  search?: string;
  page?: PageRequest;
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
  resolved: ['reported'],
  dismissed: ['reported'],
};

const HIGH_SEVERITY: ReadonlyArray<IncidentSeverityValue> = ['high', 'critical'];

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly notifications: NotificationsService,
  ) {}

  /** Aviso a quien se le asigna una incidencia (no si se la asigna uno mismo). */
  private async notifyAssignee(
    tenantId: string,
    actorId: string | null,
    inc: { id: string; title: string; assignedToUserId: string | null; facilityId: string | null },
  ): Promise<void> {
    if (!inc.assignedToUserId || inc.assignedToUserId === actorId) return;
    await this.notifications
      .create(tenantId, {
        type: 'incident.assigned',
        title: 'Te han asignado una incidencia',
        body: inc.title,
        link: `/incidents?incident=${inc.id}`,
        facilityId: inc.facilityId,
        userId: inc.assignedToUserId,
      })
      .catch(() => undefined);
  }

  /** Nº de incidencias abiertas por estado (para los badges del menú), de los locales del usuario. */
  async countOpenByStatus(
    tenantId: string,
    facilityScope?: string[] | null,
  ): Promise<{ reported: number; investigating: number }> {
    const facility = optionalFacilityWhere(facilityScope) ?? {};
    return this.prisma.withTenant(async (tx) => {
      const [reported, investigating] = await Promise.all([
        tx.incident.count({
          where: { tenantId, deletedAt: null, status: 'reported', ...facility },
        }),
        tx.incident.count({
          where: { tenantId, deletedAt: null, status: 'investigating', ...facility },
        }),
      ]);
      return { reported, investigating };
    }, tenantId);
  }

  /**
   * Comprueba el local, el trastero, el inquilino, el contrato y el responsable:
   * que existan, que sean de los locales del usuario y que encajen entre sí
   * (el trastero del local, el contrato del inquilino). Lo que falte se toma del
   * contrato o del trastero.
   */
  private async checkRefs(
    tenantId: string,
    scope: string[] | null | undefined,
    refs: {
      facilityId?: string | null | undefined;
      unitId?: string | null | undefined;
      customerId?: string | null | undefined;
      contractId?: string | null | undefined;
      assignedToUserId?: string | null | undefined;
    },
  ): Promise<{
    facilityId: string | null | undefined;
    unitId: string | null | undefined;
    customerId: string | null | undefined;
  }> {
    let { facilityId, unitId, customerId } = refs;
    await this.prisma.withTenant(async (tx) => {
      if (refs.contractId) {
        const contract = await tx.contract.findFirst({
          where: { id: refs.contractId, deletedAt: null },
          select: { customerId: true, unitId: true, unit: { select: { facilityId: true } } },
        });
        if (!contract) {
          throw new BadRequestException({
            code: 'contract_not_found',
            message: 'Contrato no encontrado',
          });
        }
        if (customerId && contract.customerId !== customerId) {
          throw new BadRequestException({
            code: 'contract_not_for_customer',
            message: 'Ese contrato no es de este inquilino',
          });
        }
        assertFacilityAllowed(scope, contract.unit.facilityId);
        customerId = customerId ?? contract.customerId;
        unitId = unitId ?? contract.unitId;
      }
      if (customerId) {
        const c = await tx.customer.count({ where: { id: customerId, deletedAt: null } });
        if (c === 0) {
          throw new BadRequestException({
            code: 'customer_not_found',
            message: 'Inquilino no encontrado',
          });
        }
      }
      if (unitId) {
        const unit = await tx.unit.findFirst({
          where: { id: unitId },
          select: { facilityId: true },
        });
        if (!unit) {
          throw new BadRequestException({
            code: 'unit_not_found',
            message: 'Trastero no encontrado',
          });
        }
        assertFacilityAllowed(scope, unit.facilityId);
        if (facilityId && unit.facilityId !== facilityId) {
          throw new BadRequestException({
            code: 'unit_not_in_facility',
            message: 'Ese trastero no es del local elegido',
          });
        }
        facilityId = facilityId ?? unit.facilityId;
      }
      if (facilityId) {
        assertFacilityAllowed(scope, facilityId);
        const f = await tx.facility.count({ where: { id: facilityId, deletedAt: null } });
        if (f === 0) {
          throw new BadRequestException({
            code: 'facility_not_found',
            message: 'Local no encontrado',
          });
        }
      }
      if (refs.assignedToUserId) {
        const user = await tx.user.count({
          where: { id: refs.assignedToUserId, isActive: true },
        });
        if (user === 0) {
          throw new BadRequestException({
            code: 'assignee_not_found',
            message: 'La persona elegida no está en el equipo o está desactivada',
          });
        }
      }
    }, tenantId);
    return { facilityId, unitId, customerId };
  }

  async list(tenantId: string, filters: ListFilters): Promise<IncidentDto[]> {
    const where: Prisma.IncidentWhereInput = { deletedAt: null };
    if (filters.status) where.status = filters.status as IncidentStatus;
    if (filters.severity) where.severity = filters.severity as IncidentSeverity;
    const facility = optionalFacilityWhere(filters.facilityScope, filters.facilityId);
    if (!facility) return [];
    Object.assign(where, facility);
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.contractId) where.contractId = filters.contractId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.search) where.title = { contains: filters.search, mode: 'insensitive' };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.incident.findMany({
          where,
          include: INCLUDE,
          orderBy: [{ status: 'asc' }, { severity: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          ...(filters.page ? pageArgs(filters.page) : { take: 500 }),
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r as IncidentWithIncludes));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<IncidentDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateIncidentInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<IncidentDto> {
    const refs = await this.checkRefs(args.tenantId, args.facilityScope, args.input);
    const fromChecklist = checklistOrigin(args.input.metadata);
    const data: Prisma.IncidentUncheckedCreateInput = {
      tenantId: args.tenantId,
      severity: args.input.severity,
      title: args.input.title,
      description: args.input.description || null,
      facilityId: refs.facilityId ?? null,
      unitId: refs.unitId ?? null,
      customerId: refs.customerId ?? null,
      contractId: args.input.contractId ?? null,
      assignedToUserId: args.input.assignedToUserId ?? null,
      reportedByUserId: args.userId,
      visibleToCustomer: !!refs.customerId && args.input.visibleToCustomer === true,
      occurredAt: args.input.occurredAt ? new Date(args.input.occurredAt) : null,
      metadata: args.input.metadata as Prisma.InputJsonValue,
    };
    const created = await this.prisma.withTenant(async (tx) => {
      if (!fromChecklist) return tx.incident.create({ data, include: INCLUDE });
      // Desde un punto de una ronda: una sola incidencia por punto, y el punto la enlaza.
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${fromChecklist.taskId}::uuid FOR UPDATE`;
      const task = await tx.task.findFirst({
        where: { id: fromChecklist.taskId, deletedAt: null },
        select: { checklist: true },
      });
      const items = (task?.checklist as ChecklistItemDto[] | null) ?? [];
      const item = items.find((it) => it.id === fromChecklist.itemId);
      if (!item) {
        throw new BadRequestException({
          code: 'checklist_item_not_found',
          message: 'Ese punto de la ronda ya no existe',
        });
      }
      if (item.incidentId) {
        const open = await tx.incident.count({ where: { id: item.incidentId, deletedAt: null } });
        if (open > 0) {
          throw new ConflictException({
            code: 'incident_already_open',
            message: 'Ya hay una incidencia abierta para este punto',
            details: { incidentId: item.incidentId },
          });
        }
      }
      const row = await tx.incident.create({ data, include: INCLUDE });
      await tx.task.update({
        where: { id: fromChecklist.taskId },
        data: {
          checklist: items.map((it) =>
            it.id === fromChecklist.itemId ? { ...it, incidentId: row.id } : it,
          ) as unknown as Prisma.InputJsonValue,
        },
      });
      return row;
    }, args.tenantId);
    await this.writeAudit('incident.created', args, created.id);
    await this.notifyAssignee(args.tenantId, args.userId, created);

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

    const created = await this.prisma.withTenant(async (tx) => {
      // Con un solo trastero, la incidencia va a su local, trastero y contrato;
      // con varios en el mismo local, al menos al local.
      const live = await tx.contract.findMany({
        where: {
          customerId: args.customerId,
          deletedAt: null,
          status: { in: ['active', 'ending'] },
        },
        select: { id: true, unitId: true, unit: { select: { facilityId: true } } },
        take: 20,
      });
      const facilities = new Set(live.map((c) => c.unit.facilityId));
      const only = live.length === 1 ? live[0]! : null;
      return tx.incident.create({
        data: {
          tenantId: args.tenantId,
          severity: 'medium',
          title: args.input.title,
          description: args.input.description || null,
          customerId: args.customerId,
          facilityId: facilities.size === 1 ? [...facilities][0]! : null,
          unitId: only?.unitId ?? null,
          contractId: only?.id ?? null,
          reportedByUserId: null,
          reportedByExternal: `Portal: ${reporter}`,
          visibleToCustomer: true,
        },
        include: INCLUDE,
      });
    }, args.tenantId);

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
          // Solo las suyas o las que el equipo deja ver (nunca las notas internas).
          where: { tenantId, customerId, deletedAt: null, visibleToCustomer: true },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            severity: true,
            createdAt: true,
            resolution: true,
            resolvedAt: true,
            dismissedAt: true,
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
    resolution?: string | null;
    resolvedAt?: Date | null;
    dismissedAt?: Date | null;
  }): PortalIncidentDto {
    const closed = i.status === 'resolved' || i.status === 'dismissed';
    return {
      id: i.id,
      title: i.title,
      description: i.description,
      status: i.status,
      severity: i.severity,
      createdAt: i.createdAt.toISOString(),
      resolution: closed ? (i.resolution ?? null) : null,
      closedAt: closed ? ((i.resolvedAt ?? i.dismissedAt)?.toISOString() ?? null) : null,
    };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateIncidentInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<IncidentDto> {
    const before = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    const pick = <K extends 'facilityId' | 'unitId' | 'customerId' | 'contractId'>(k: K) =>
      args.input[k] !== undefined ? args.input[k] : before[k];
    const refs = await this.checkRefs(args.tenantId, args.facilityScope, {
      facilityId: pick('facilityId'),
      unitId: pick('unitId'),
      customerId: pick('customerId'),
      contractId: pick('contractId'),
      assignedToUserId: args.input.assignedToUserId,
    });
    const data: Prisma.IncidentUncheckedUpdateInput = {};
    if (args.input.severity !== undefined) data.severity = args.input.severity;
    if (args.input.title !== undefined) data.title = args.input.title;
    if (args.input.description !== undefined) data.description = args.input.description || null;
    if (refs.facilityId !== before.facilityId) data.facilityId = refs.facilityId ?? null;
    if (refs.unitId !== before.unitId) data.unitId = refs.unitId ?? null;
    if (refs.customerId !== before.customerId) data.customerId = refs.customerId ?? null;
    if (args.input.contractId !== undefined) data.contractId = args.input.contractId ?? null;
    if (args.input.visibleToCustomer !== undefined) {
      data.visibleToCustomer = !!(refs.customerId ?? null) && args.input.visibleToCustomer;
    } else if (!refs.customerId && before.visibleToCustomer) {
      data.visibleToCustomer = false;
    }
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
    if (updated.assignedToUserId !== before.assignedToUserId) {
      await this.notifyAssignee(args.tenantId, args.userId, updated);
    }
    return this.toDto(updated as IncidentWithIncludes);
  }

  async transition(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: TransitionIncidentInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<IncidentDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
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
      // Reabrir: fuera el cierre y lo que se escribió al cerrarla.
      data.resolvedAt = null;
      data.dismissedAt = null;
      data.resolution = null;
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      const moved = await tx.incident.updateMany({
        where: { id: args.id, status: existing.status },
        data,
      });
      if (moved.count === 0) {
        throw new ConflictException({
          code: 'incident_changed',
          message: 'La incidencia acaba de cambiar: vuelve a abrirla',
        });
      }
      return tx.incident.findUniqueOrThrow({ where: { id: args.id }, include: INCLUDE });
    }, args.tenantId);
    await this.writeAudit(`incident.${args.input.status}`, args, args.id);
    // Cierra el loop: si la incidencia era de un inquilino, avísale por push de
    // la resolución (antes solo se enteraba entrando al portal).
    if (
      (args.input.status === 'resolved' || args.input.status === 'dismissed') &&
      updated.customerId &&
      updated.visibleToCustomer
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
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    await this.prisma.withTenant(
      (tx) => tx.incident.update({ where: { id: args.id }, data: { deletedAt: new Date() } }),
      args.tenantId,
    );
    await this.writeAudit('incident.deleted', args, args.id);
  }

  async listComments(
    tenantId: string,
    incidentId: string,
    facilityScope?: string[] | null,
  ): Promise<IncidentCommentDto[]> {
    await this.findOrThrow(tenantId, incidentId, facilityScope);
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
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<IncidentCommentDto> {
    await this.findOrThrow(args.tenantId, args.incidentId, args.facilityScope);
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

  /**
   * Lo que rodea a una incidencia: su trastero, quién lo ha tenido (los últimos
   * contratos) y los últimos accesos del trastero o del inquilino.
   */
  async getContext(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<IncidentContextDto> {
    const inc = await this.findOrThrow(tenantId, id, facilityScope);
    return this.prisma.withTenant(async (tx) => {
      const unit = inc.unitId
        ? await tx.unit.findFirst({
            where: { id: inc.unitId },
            select: { id: true, code: true, status: true, facility: { select: { name: true } } },
          })
        : null;
      const contracts = await tx.contract.findMany({
        where: {
          deletedAt: null,
          ...(inc.unitId
            ? { unitId: inc.unitId }
            : inc.customerId
              ? { customerId: inc.customerId }
              : { id: '00000000-0000-0000-0000-000000000000' }),
        },
        orderBy: { startDate: 'desc' },
        take: 5,
        select: {
          id: true,
          contractNumber: true,
          customerId: true,
          status: true,
          startDate: true,
          endDate: true,
          customer: {
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          },
        },
      });
      const customerIds = [
        ...new Set(
          [inc.customerId, ...contracts.slice(0, 2).map((c) => c.customerId)].filter(
            (x): x is string => !!x,
          ),
        ),
      ];
      const or: Prisma.AccessLogWhereInput[] = [];
      if (inc.unitId) or.push({ device: { unitId: inc.unitId } });
      if (customerIds.length > 0) or.push({ customerId: { in: customerIds } });
      const logs =
        or.length === 0
          ? []
          : await tx.accessLog.findMany({
              where: { OR: or },
              orderBy: { occurredAt: 'desc' },
              take: 15,
              select: {
                id: true,
                occurredAt: true,
                result: true,
                device: { select: { name: true } },
                customer: {
                  select: {
                    customerType: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            });
      const name = (c: {
        customerType: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      }) =>
        c.customerType === 'business'
          ? (c.companyName ?? 'Empresa')
          : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
      return {
        unit: unit
          ? { id: unit.id, code: unit.code, status: unit.status, facilityName: unit.facility.name }
          : null,
        contracts: contracts.map((c) => ({
          id: c.id,
          contractNumber: c.contractNumber,
          customerId: c.customerId,
          customerName: name(c.customer),
          status: c.status,
          startDate: c.startDate.toISOString().slice(0, 10),
          endDate: c.endDate?.toISOString().slice(0, 10) ?? null,
        })),
        accessLogs: logs.map((l) => ({
          id: l.id,
          occurredAt: l.occurredAt.toISOString(),
          result: l.result,
          customerName: l.customer ? name(l.customer) : null,
          deviceName: l.device?.name ?? null,
        })),
      };
    }, tenantId);
  }

  private async findOrThrow(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<IncidentWithIncludes> {
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
    // Alcance por local: lo de un local fuera del suyo no se ve ni se toca
    // (lo de toda la empresa, sin local, sí).
    if (row.facilityId) assertFacilityAllowed(facilityScope, row.facilityId);
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
      visibleToCustomer: i.visibleToCustomer,
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

/** La incidencia sale de un punto de una ronda (`metadata.source = 'checklist'`). */
function checklistOrigin(
  metadata: Record<string, unknown> | undefined,
): { taskId: string; itemId: string } | null {
  const m = metadata ?? {};
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (m.source !== 'checklist') return null;
  const taskId = typeof m.taskId === 'string' ? m.taskId : '';
  const itemId = typeof m.checklistItemId === 'string' ? m.checklistItemId : '';
  return uuid.test(taskId) && uuid.test(itemId) ? { taskId, itemId } : null;
}
