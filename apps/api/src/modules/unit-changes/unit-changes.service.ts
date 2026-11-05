import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { noLiveReservationWhere, unitHeldByOther } from '../../common/unit-holds';
import { DOMAIN_EVENTS, type UnitRequestResolvedPayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Prisma } from '@storageos/database';
import type {
  PortalUnitChangeRequestInput,
  PortalUnitChangeRequestDto,
  ResolveUnitChangeRequestInput,
  UnitChangeRequestDto,
  UnitChangeRequestStatus,
} from '@storageos/shared';

function customerName(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return 'Cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

@Injectable()
export class UnitChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  // ---- portal ----

  async createFromPortal(args: {
    tenantId: string;
    customerId: string;
    input: PortalUnitChangeRequestInput;
  }): Promise<PortalUnitChangeRequestDto> {
    const { tenantId, customerId, input } = args;
    if (input.desiredDate && input.desiredDate < todayInTimezone().toISOString().slice(0, 10)) {
      throw new BadRequestException({
        code: 'invalid_date',
        message: 'La fecha del cambio no puede ser anterior a hoy',
      });
    }
    // Solo una petición abierta por contrato: la segunda sería el mismo trabajo.
    const repeated = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.count({
          where: {
            tenantId,
            customerId,
            status: 'pending',
            contractId: input.contractId ?? null,
            ...(input.contractId ? {} : { note: input.note }),
          },
        }),
      tenantId,
    );
    if (repeated > 0) {
      throw new ConflictException({
        code: 'unit_change_already_pending',
        message: 'Ya tienes una solicitud de cambio pendiente: te responderemos pronto',
      });
    }
    // Si indica contrato, validamos que es suyo.
    let contractFacilityId: string | null = null;
    if (input.contractId) {
      const contractId = input.contractId;
      const owned = await this.prisma.withTenant(
        (tx) =>
          tx.contract.findFirst({
            where: {
              id: contractId,
              tenantId,
              customerId,
              deletedAt: null,
              status: { in: ['active', 'ending'] },
            },
            select: { id: true, unit: { select: { facilityId: true } } },
          }),
        tenantId,
      );
      if (!owned) {
        throw new NotFoundException({
          code: 'contract_not_found',
          message: 'Contrato no encontrado',
        });
      }
      contractFacilityId = owned.unit.facilityId;
    }
    // Trastero elegido: libre y del mismo local que el suyo.
    if (input.targetUnitId) {
      const targetUnitId = input.targetUnitId;
      if (!contractFacilityId) {
        throw new BadRequestException({
          code: 'contract_required',
          message: 'Indica qué trastero quieres cambiar',
        });
      }
      const free = await this.prisma.withTenant(async (tx) => {
        const target = await tx.unit.findFirst({
          where: {
            id: targetUnitId,
            tenantId,
            facilityId: contractFacilityId!,
            status: 'available',
            ...noLiveReservationWhere(),
          },
          select: { id: true },
        });
        return !!target && !(await unitHeldByOther(tx, { unitId: target.id }));
      }, tenantId);
      if (!free) {
        throw new BadRequestException({
          code: 'unit_not_available',
          message: 'Ese trastero ya no está disponible',
        });
      }
    }
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.create({
          data: {
            tenantId,
            customerId,
            contractId: input.contractId ?? null,
            targetUnitId: input.targetUnitId ?? null,
            desiredDate: input.desiredDate ? new Date(`${input.desiredDate}T00:00:00Z`) : null,
            note: input.note,
            status: 'pending',
          },
          include: PORTAL_INCLUDE,
        }),
      tenantId,
    );
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: customerId, tenantId },
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        }),
      tenantId,
    );
    await this.notifications.create(tenantId, {
      type: 'unit_change.requested',
      title: `Cambio de trastero solicitado — ${customerName(customer)}`,
      body: (created.targetUnit
        ? `Quiere el trastero ${created.targetUnit.code}${input.desiredDate ? ` desde el ${input.desiredDate}` : ''}. ${input.note}`
        : input.note
      )
        .trim()
        .slice(0, 140),
      link: '/unit-change-requests',
      contractId: created.contractId,
    });
    return this.toPortalDto(created);
  }

  async listForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<PortalUnitChangeRequestDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.findMany({
          where: { tenantId, customerId },
          orderBy: { createdAt: 'desc' },
          include: PORTAL_INCLUDE,
        }),
      tenantId,
    );
    return rows.map((r) => this.toPortalDto(r));
  }

  // ---- staff ----

  /** Nº de solicitudes de cambio de trastero pendientes de atender. */
  async countPending(tenantId: string, facilityScope?: string[] | null): Promise<number> {
    const ids = resolveFacilityFilter(facilityScope, undefined);
    if (ids === null) return 0;
    return this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.count({
          where: { tenantId, status: 'pending', ...this.facilityWhere(ids, undefined) },
        }),
      tenantId,
    );
  }

  /** El local es el del trastero del contrato; sin contrato es de toda la empresa. */
  private facilityWhere(
    ids: string[] | undefined,
    facilityId: string | undefined,
  ): Prisma.UnitChangeRequestWhereInput {
    if (!ids) return {};
    return facilityId
      ? { contract: { unit: { facilityId: { in: ids } } } }
      : { OR: [{ contract: { unit: { facilityId: { in: ids } } } }, { contractId: null }] };
  }

  async list(
    tenantId: string,
    status?: string,
    filters: { facilityId?: string; facilityScope?: string[] | null } = {},
  ): Promise<UnitChangeRequestDto[]> {
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (ids === null) return [];
    const facility = this.facilityWhere(ids, filters.facilityId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.findMany({
          where: { tenantId, ...(status ? { status } : {}), ...facility },
          orderBy: { createdAt: 'desc' },
          include: {
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            contract: {
              select: {
                contractNumber: true,
                priceMonthly: true,
                unit: { select: { code: true } },
              },
            },
            targetUnit: { select: { id: true, code: true, basePriceMonthly: true, status: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Contrato de una solicitud pendiente, para trasladarlo desde ella. */
  async pendingContractId(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<string> {
    const r = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.findFirst({
          where: { id, tenantId },
          select: {
            status: true,
            contractId: true,
            contract: { select: { unit: { select: { facilityId: true } } } },
          },
        }),
      tenantId,
    );
    if (!r) {
      throw new NotFoundException({
        code: 'request_not_found',
        message: 'Solicitud no encontrada',
      });
    }
    if (r.contract) assertFacilityAllowed(facilityScope, r.contract.unit.facilityId);
    if (r.status !== 'pending') {
      throw new BadRequestException({
        code: 'already_resolved',
        message: 'La solicitud ya está resuelta',
      });
    }
    if (!r.contractId) {
      throw new BadRequestException({
        code: 'request_without_contract',
        message: 'La solicitud no indica qué contrato trasladar',
      });
    }
    return r.contractId;
  }

  async resolve(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: ResolveUnitChangeRequestInput;
    facilityScope?: string[] | null;
    /** El traslado ya está hecho o programado. */
    moved?: boolean;
  }): Promise<UnitChangeRequestDto> {
    const { tenantId, userId, id, input } = args;
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.findFirst({
          where: { id, tenantId },
          select: {
            status: true,
            contract: { select: { unit: { select: { facilityId: true } } } },
          },
        }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'request_not_found',
        message: 'Solicitud no encontrada',
      });
    }
    const facilityId = existing.contract?.unit.facilityId;
    if (facilityId) assertFacilityAllowed(args.facilityScope, facilityId);
    if (existing.status !== 'pending') {
      throw new BadRequestException({
        code: 'already_resolved',
        message: 'La solicitud ya está resuelta',
      });
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      // Reclamo: de dos respuestas a la vez solo una avisa al inquilino.
      const { count } = await tx.unitChangeRequest.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: input.status,
          resolutionNote: input.resolutionNote ?? null,
          handledByUserId: userId,
          handledAt: new Date(),
        },
      });
      if (count === 0) {
        throw new BadRequestException({
          code: 'already_resolved',
          message: 'La solicitud ya está resuelta',
        });
      }
      return tx.unitChangeRequest.findUniqueOrThrow({
        where: { id },
        include: {
          customer: {
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          },
          contract: {
            select: {
              contractNumber: true,
              priceMonthly: true,
              unit: { select: { code: true } },
            },
          },
          targetUnit: { select: { id: true, code: true, basePriceMonthly: true, status: true } },
        },
      });
    }, tenantId);
    this.events.emit(DOMAIN_EVENTS.unit_request_resolved, {
      tenantId,
      customerId: updated.customerId,
      request: 'change',
      outcome: args.moved ? 'moved' : input.status,
      note: input.resolutionNote?.trim() || null,
      contractId: updated.contractId,
    } satisfies UnitRequestResolvedPayload);
    return this.toDto(updated);
  }

  // ---- mappers ----

  private toPortalDto(r: {
    id: string;
    note: string;
    status: string;
    resolutionNote: string | null;
    createdAt: Date;
    desiredDate: Date | null;
    contract: { contractNumber: string } | null;
    targetUnit: { code: string } | null;
  }): PortalUnitChangeRequestDto {
    return {
      id: r.id,
      contractNumber: r.contract?.contractNumber ?? null,
      targetUnitCode: r.targetUnit?.code ?? null,
      desiredDate: r.desiredDate?.toISOString().slice(0, 10) ?? null,
      note: r.note,
      status: r.status as UnitChangeRequestStatus,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private toDto(r: {
    id: string;
    customerId: string;
    contractId: string | null;
    note: string;
    status: string;
    resolutionNote: string | null;
    createdAt: Date;
    handledAt: Date | null;
    desiredDate: Date | null;
    targetUnitId: string | null;
    targetUnit: { id: string; code: string; basePriceMonthly: unknown; status: string } | null;
    customer: {
      customerType: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    contract: {
      contractNumber: string;
      priceMonthly: unknown;
      unit: { code: string } | null;
    } | null;
  }): UnitChangeRequestDto {
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: customerName(r.customer),
      contractId: r.contractId,
      contractNumber: r.contract?.contractNumber ?? null,
      unitCode: r.contract?.unit?.code ?? null,
      targetUnitId: r.targetUnitId,
      targetUnitCode: r.targetUnit?.code ?? null,
      targetUnitPrice: r.targetUnit ? Number(r.targetUnit.basePriceMonthly) : null,
      targetUnitFree: r.targetUnit ? r.targetUnit.status === 'available' : null,
      currentPrice: r.contract ? Number(r.contract.priceMonthly) : null,
      desiredDate: r.desiredDate?.toISOString().slice(0, 10) ?? null,
      note: r.note,
      status: r.status as UnitChangeRequestStatus,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt.toISOString(),
      handledAt: r.handledAt?.toISOString() ?? null,
    };
  }
}

const PORTAL_INCLUDE = {
  contract: { select: { contractNumber: true } },
  targetUnit: { select: { code: true } },
} as const;
