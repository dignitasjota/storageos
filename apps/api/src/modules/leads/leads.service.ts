import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload } from '../automations/domain-events';
import type { Lead, LeadStatus, Prisma } from '@storageos/database';
import type {
  ConvertLeadInput,
  CreateLeadInput,
  LeadDto,
  LeadStatusValue,
  TransitionLeadInput,
  UpdateLeadInput,
  WidgetLeadInput,
} from '@storageos/shared';

interface ListFilters {
  status?: LeadStatusValue;
  assignedToUserId?: string;
  source?: string;
  search?: string;
}

type LeadWithIncludes = Lead & {
  preferredFacility?: { name: string } | null;
  preferredUnitType?: { name: string } | null;
  assignedTo?: { fullName: string } | null;
};

const ALLOWED_TRANSITIONS: Record<LeadStatusValue, LeadStatusValue[]> = {
  new: ['contacted', 'qualified', 'lost'],
  contacted: ['qualified', 'lost', 'new'],
  qualified: ['won', 'lost', 'contacted'],
  won: [],
  lost: ['new'],
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<LeadDto[]> {
    const where: Prisma.LeadWhereInput = { deletedAt: null };
    if (filters.status) where.status = filters.status as LeadStatus;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.source) {
      where.source = filters.source as NonNullable<Prisma.LeadWhereInput['source']>;
    }
    if (filters.search) {
      const q = filters.search;
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where,
          include: {
            preferredFacility: { select: { name: true } },
            preferredUnitType: { select: { name: true } },
            assignedTo: { select: { fullName: true } },
          },
          orderBy: [{ updatedAt: 'desc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<LeadDto> {
    const row = await this.findOrThrow(tenantId, id, true);
    return this.toDto(row);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    const data = this.buildCreateData(args.tenantId, args.input);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data,
          include: {
            preferredFacility: { select: { name: true } },
            preferredUnitType: { select: { name: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.created',
      entityType: 'Lead',
      entityId: created.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    this.emitLeadCreated(args.tenantId, created);
    return this.toDto(created);
  }

  /**
   * Alta publica desde el widget. NO requiere auth (se llama desde el
   * controlador `/public/widget/...`). Aplica honeypot, deja origen
   * `widget`, asigna sin user (UserId = null en audit).
   */
  async createFromWidget(args: {
    tenantId: string;
    input: WidgetLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    if (args.input.hp) {
      this.logger.warn(`[widget] honeypot detectado tenant=${args.tenantId}, descartado`);
      throw new ConflictException({ code: 'invalid_payload', message: 'Solicitud invalida' });
    }
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data: {
            tenantId: args.tenantId,
            source: 'widget',
            firstName: args.input.firstName,
            lastName: args.input.lastName || null,
            email: args.input.email,
            phone: args.input.phone,
            message: args.input.message || null,
            preferredFacilityId: args.input.preferredFacilityId ?? null,
            preferredUnitTypeId: args.input.preferredUnitTypeId ?? null,
            preferredStartDate: args.input.preferredStartDate
              ? new Date(args.input.preferredStartDate)
              : null,
            estimatedDurationMonths: args.input.estimatedDurationMonths ?? null,
            metadata: {
              acceptsMarketing: args.input.acceptsMarketing,
              acceptsTerms: args.input.acceptsTerms,
              userAgent: args.meta.userAgent ?? null,
              ipAddress: args.meta.ipAddress ?? null,
            } satisfies Prisma.InputJsonValue,
          },
          include: {
            preferredFacility: { select: { name: true } },
            preferredUnitType: { select: { name: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      action: 'lead.widget_received',
      entityType: 'Lead',
      entityId: created.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    this.emitLeadCreated(args.tenantId, created);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.LeadUncheckedUpdateInput = {};
    const set = <K extends keyof UpdateLeadInput>(key: K) => {
      const v = args.input[key];
      if (v !== undefined) (data as Record<string, unknown>)[key] = v ?? null;
    };
    set('firstName');
    set('lastName');
    set('companyName');
    set('email');
    set('phone');
    set('message');
    set('preferredFacilityId');
    set('preferredUnitTypeId');
    set('estimatedDurationMonths');
    set('budgetMonthly');
    set('assignedToUserId');
    set('source');
    if (args.input.preferredStartDate !== undefined) {
      data.preferredStartDate = args.input.preferredStartDate
        ? new Date(args.input.preferredStartDate)
        : null;
    }
    if (args.input.metadata !== undefined)
      data.metadata = args.input.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.lead.update({
          where: { id: args.id },
          data,
          include: {
            preferredFacility: { select: { name: true } },
            preferredUnitType: { select: { name: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.updated',
      entityType: 'Lead',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  async transition(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: TransitionLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    const allowed = ALLOWED_TRANSITIONS[existing.status as LeadStatusValue];
    if (!allowed.includes(args.input.status)) {
      throw new ConflictException({
        code: 'invalid_lead_transition',
        message: `No se puede pasar de ${existing.status} a ${args.input.status}`,
      });
    }
    const now = new Date();
    const data: Prisma.LeadUncheckedUpdateInput = { status: args.input.status };
    if (args.input.status === 'contacted') data.contactedAt = now;
    if (args.input.status === 'qualified') data.qualifiedAt = now;
    if (args.input.status === 'won') data.wonAt = now;
    if (args.input.status === 'lost') {
      data.lostAt = now;
      if (args.input.reason) data.lostReason = args.input.reason;
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.lead.update({
          where: { id: args.id },
          data,
          include: {
            preferredFacility: { select: { name: true } },
            preferredUnitType: { select: { name: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: `lead.${args.input.status}`,
      entityType: 'Lead',
      entityId: args.id,
      ...(args.input.reason ? { changes: { reason: args.input.reason } } : {}),
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  /**
   * Convierte el lead en customer y, opcionalmente, en reservation.
   * Si `customerId` no se pasa, se crea uno nuevo con los datos del lead.
   * Cierra el lead como `won`. Atomic en `$transaction`.
   */
  async convert(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: ConvertLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    if (existing.status === 'won') {
      throw new ConflictException({
        code: 'lead_already_won',
        message: 'Lead ya convertido',
      });
    }
    const result = await this.prisma.withTenant(async (tx) => {
      let customerId = args.input.customerId ?? null;
      if (!customerId) {
        const customer = await tx.customer.create({
          data: {
            tenantId: args.tenantId,
            customerType: existing.companyName ? 'business' : 'individual',
            firstName: existing.firstName,
            lastName: existing.lastName,
            companyName: existing.companyName,
            email: existing.email,
            phone: existing.phone,
          },
        });
        customerId = customer.id;
      }
      let reservationId: string | null = null;
      if (args.input.reservation) {
        const reservation = await tx.reservation.create({
          data: {
            tenantId: args.tenantId,
            unitId: args.input.reservation.unitId,
            customerId,
            status: 'pending',
            validFrom: new Date(args.input.reservation.validFrom),
            validUntil: new Date(args.input.reservation.validUntil),
            depositAmount: args.input.reservation.depositAmount,
          },
        });
        reservationId = reservation.id;
      }
      return tx.lead.update({
        where: { id: args.id },
        data: {
          status: 'won',
          wonAt: new Date(),
          convertedCustomerId: customerId,
          convertedReservationId: reservationId,
        },
        include: {
          preferredFacility: { select: { name: true } },
          preferredUnitType: { select: { name: true } },
          assignedTo: { select: { fullName: true } },
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.converted',
      entityType: 'Lead',
      entityId: args.id,
      changes: {
        customerId: result.convertedCustomerId,
        reservationId: result.convertedReservationId,
      },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(result);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id);
    await this.prisma.withTenant(
      (tx) => tx.lead.update({ where: { id: args.id }, data: { deletedAt: new Date() } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.deleted',
      entityType: 'Lead',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  // -----------------------------------------------------------------

  private async findOrThrow(
    tenantId: string,
    id: string,
    includeRelations = false,
  ): Promise<LeadWithIncludes> {
    const row = await this.prisma.withTenant(
      (tx) =>
        includeRelations
          ? tx.lead.findFirst({
              where: { id, deletedAt: null },
              include: {
                preferredFacility: { select: { name: true } },
                preferredUnitType: { select: { name: true } },
                assignedTo: { select: { fullName: true } },
              },
            })
          : tx.lead.findFirst({ where: { id, deletedAt: null } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
    }
    return row as LeadWithIncludes;
  }

  private buildCreateData(
    tenantId: string,
    input: CreateLeadInput,
  ): Prisma.LeadUncheckedCreateInput {
    return {
      tenantId,
      source: input.source,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      companyName: input.companyName || null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      message: input.message || null,
      preferredFacilityId: input.preferredFacilityId ?? null,
      preferredUnitTypeId: input.preferredUnitTypeId ?? null,
      preferredStartDate: input.preferredStartDate ? new Date(input.preferredStartDate) : null,
      estimatedDurationMonths: input.estimatedDurationMonths ?? null,
      budgetMonthly: input.budgetMonthly ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      metadata: input.metadata as Prisma.InputJsonValue,
    };
  }

  private emitLeadCreated(tenantId: string, lead: Lead): void {
    const displayName =
      lead.companyName ?? `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() ?? 'Lead';
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'lead',
      entityId: lead.id,
      recipientEmail: lead.email,
      recipientPhone: lead.phone,
      leadId: lead.id,
      scope: {
        lead: {
          firstName: lead.firstName ?? '',
          lastName: lead.lastName ?? '',
          displayName,
          email: lead.email ?? '',
          phone: lead.phone ?? '',
        },
      },
    };
    this.events.emit(DOMAIN_EVENTS.lead_created, payload);
  }

  private toDto(l: LeadWithIncludes): LeadDto {
    const displayName =
      l.companyName ?? `${l.firstName ?? ''} ${l.lastName ?? ''}`.trim() ?? 'Lead';
    return {
      id: l.id,
      status: l.status,
      source: l.source,
      firstName: l.firstName,
      lastName: l.lastName,
      companyName: l.companyName,
      displayName,
      email: l.email,
      phone: l.phone,
      message: l.message,
      preferredFacilityId: l.preferredFacilityId,
      preferredFacilityName: l.preferredFacility?.name ?? null,
      preferredUnitTypeId: l.preferredUnitTypeId,
      preferredUnitTypeName: l.preferredUnitType?.name ?? null,
      preferredStartDate: l.preferredStartDate?.toISOString().slice(0, 10) ?? null,
      estimatedDurationMonths: l.estimatedDurationMonths,
      budgetMonthly: l.budgetMonthly ? Number(l.budgetMonthly) : null,
      assignedToUserId: l.assignedToUserId,
      assignedToName: l.assignedTo?.fullName ?? null,
      contactedAt: l.contactedAt?.toISOString() ?? null,
      qualifiedAt: l.qualifiedAt?.toISOString() ?? null,
      wonAt: l.wonAt?.toISOString() ?? null,
      lostAt: l.lostAt?.toISOString() ?? null,
      lostReason: l.lostReason,
      convertedCustomerId: l.convertedCustomerId,
      convertedContractId: l.convertedContractId,
      convertedReservationId: l.convertedReservationId,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  }
}
