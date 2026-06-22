import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

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
  ) {}

  // ---- portal ----

  async createFromPortal(args: {
    tenantId: string;
    customerId: string;
    input: PortalUnitChangeRequestInput;
  }): Promise<PortalUnitChangeRequestDto> {
    const { tenantId, customerId, input } = args;
    // Si indica contrato, validamos que es suyo.
    if (input.contractId) {
      const contractId = input.contractId;
      const owned = await this.prisma.withTenant(
        (tx) =>
          tx.contract.findFirst({
            where: { id: contractId, tenantId, customerId },
            select: { id: true },
          }),
        tenantId,
      );
      if (!owned) {
        throw new NotFoundException({
          code: 'contract_not_found',
          message: 'Contrato no encontrado',
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
            note: input.note,
            status: 'pending',
          },
          include: { contract: { select: { contractNumber: true } } },
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
      body: input.note.slice(0, 140),
      link: '/unit-change-requests',
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
          include: { contract: { select: { contractNumber: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toPortalDto(r));
  }

  // ---- staff ----

  async list(tenantId: string, status?: string): Promise<UnitChangeRequestDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.findMany({
          where: { tenantId, ...(status ? { status } : {}) },
          orderBy: { createdAt: 'desc' },
          include: {
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            contract: { select: { contractNumber: true, unit: { select: { code: true } } } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async resolve(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: ResolveUnitChangeRequestInput;
  }): Promise<UnitChangeRequestDto> {
    const { tenantId, userId, id, input } = args;
    const existing = await this.prisma.withTenant(
      (tx) => tx.unitChangeRequest.findFirst({ where: { id, tenantId }, select: { status: true } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'request_not_found',
        message: 'Solicitud no encontrada',
      });
    }
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
            contract: { select: { contractNumber: true, unit: { select: { code: true } } } },
          },
        }),
      tenantId,
    );
    return this.toDto(updated);
  }

  // ---- mappers ----

  private toPortalDto(r: {
    id: string;
    note: string;
    status: string;
    createdAt: Date;
    contract: { contractNumber: string } | null;
  }): PortalUnitChangeRequestDto {
    return {
      id: r.id,
      contractNumber: r.contract?.contractNumber ?? null,
      note: r.note,
      status: r.status as UnitChangeRequestStatus,
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
    customer: {
      customerType: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    contract: { contractNumber: string; unit: { code: string } | null } | null;
  }): UnitChangeRequestDto {
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: customerName(r.customer),
      contractId: r.contractId,
      contractNumber: r.contract?.contractNumber ?? null,
      unitCode: r.contract?.unit?.code ?? null,
      note: r.note,
      status: r.status as UnitChangeRequestStatus,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt.toISOString(),
      handledAt: r.handledAt?.toISOString() ?? null,
    };
  }
}
