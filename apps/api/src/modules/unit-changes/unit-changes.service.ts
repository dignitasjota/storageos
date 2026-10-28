import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { DOMAIN_EVENTS, type CustomerNotifyPayload } from '../automations/domain-events';
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
      const target = await this.prisma.withTenant(
        (tx) =>
          tx.unit.findFirst({
            where: {
              id: targetUnitId,
              tenantId,
              facilityId: contractFacilityId!,
              status: 'available',
            },
            select: { id: true },
          }),
        tenantId,
      );
      if (!target) {
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
  async countPending(tenantId: string): Promise<number> {
    return this.prisma.withTenant(
      (tx) => tx.unitChangeRequest.count({ where: { tenantId, status: 'pending' } }),
      tenantId,
    );
  }

  async list(
    tenantId: string,
    status?: string,
    filters: { facilityId?: string; facilityScope?: string[] | null } = {},
  ): Promise<UnitChangeRequestDto[]> {
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (ids === null) return [];
    // El local es el del trastero del contrato; sin contrato indicado es de toda la empresa.
    const facility: Prisma.UnitChangeRequestWhereInput = !ids
      ? {}
      : filters.facilityId
        ? { contract: { unit: { facilityId: { in: ids } } } }
        : { OR: [{ contract: { unit: { facilityId: { in: ids } } } }, { contractId: null }] };
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
            targetUnit: { select: { id: true, code: true, basePriceMonthly: true } },
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
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.update({
          where: { id },
          data: {
            status: input.status,
            resolutionNote: input.resolutionNote ?? null,
            handledByUserId: userId,
            handledAt: new Date(),
          },
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
            targetUnit: { select: { id: true, code: true, basePriceMonthly: true } },
          },
        }),
      tenantId,
    );
    // Cierra el loop: avisa al inquilino por push de la resolución (aprobada o
    // rechazada), con el motivo si lo hay.
    const approved = input.status === 'handled';
    const note = input.resolutionNote?.trim();
    this.events.emit(DOMAIN_EVENTS.unit_change_resolved, {
      tenantId,
      customerId: updated.customerId,
      title: approved ? 'Cambio de trastero aprobado' : 'Solicitud de cambio revisada',
      body: approved
        ? `Tu solicitud de cambio de trastero se ha gestionado.${note ? ` ${note}` : ''}`
        : `Tu solicitud de cambio de trastero no se ha podido aprobar.${note ? ` ${note}` : ''}`,
      url: '/portal/login',
    } satisfies CustomerNotifyPayload);
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
    targetUnit: { id: string; code: string; basePriceMonthly: unknown } | null;
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
