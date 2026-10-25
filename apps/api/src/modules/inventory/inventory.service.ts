import { ConflictException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { resolveFacilityFilter } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';
import type { InventoryIssueDto, UnitStatusValue } from '@storageos/shared';

const LIVE_CONTRACT: Prisma.ContractWhereInput = {
  status: { in: ['active', 'ending'] },
  deletedAt: null,
};

type UnitRow = {
  id: string;
  code: string;
  status: string;
  facilityId: string;
  facility: { name: string };
};

const INCLUDE = { facility: { select: { name: true } } } satisfies Prisma.UnitInclude;

function toIssue(u: UnitRow, expected: UnitStatusValue, reason: string): InventoryIssueDto {
  return {
    unitId: u.id,
    code: u.code,
    facilityId: u.facilityId,
    facilityName: u.facility.name,
    currentStatus: u.status as UnitStatusValue,
    expectedStatus: expected,
    reason,
  };
}

/**
 * Reconciliación de inventario: detecta trasteros en un estado imposible según
 * sus contratos/reservas (ocupado sin contrato vivo, disponible con contrato
 * vivo, reservado sin reserva ni hold). Ayuda a corregir descuadres que dejarían
 * un trastero fuera de la venta o doblemente asignado. Filtra por `tenantId`
 * explícito (seguro con `PrismaAdminService`).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly eventBus: EventEmitter2,
  ) {}

  /**
   * Corrige un descuadre: vuelve a comprobarlo y pone el estado que le toca
   * (también «ocupado», que el cambio de estado manual no permite porque solo
   * lo da un contrato: aquí el contrato existe).
   */
  async fix(args: {
    tenantId: string;
    userId: string;
    unitId: string;
    facilityScope?: string[] | null;
  }): Promise<InventoryIssueDto> {
    const issues = await this.findIssues(args.tenantId, args.facilityScope);
    const issue = issues.find((i) => i.unitId === args.unitId);
    if (!issue) {
      throw new ConflictException({
        code: 'no_inventory_issue',
        message: 'Este trastero ya no tiene ningún descuadre',
      });
    }
    await this.admin.$transaction(async (tx) => {
      const claimed = await tx.unit.updateMany({
        where: { id: issue.unitId, tenantId: args.tenantId, status: issue.currentStatus },
        data: { status: issue.expectedStatus },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'no_inventory_issue',
          message: 'El trastero ha cambiado de estado mientras tanto',
        });
      }
      await tx.unitStatusHistory.create({
        data: {
          tenantId: args.tenantId,
          unitId: issue.unitId,
          previousStatus: issue.currentStatus,
          newStatus: issue.expectedStatus,
          changedByUserId: args.userId,
          reason: `Reconciliación de inventario: ${issue.reason}`,
        },
      });
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'unit.status_reconciled',
      entityType: 'Unit',
      entityId: issue.unitId,
      changes: { from: issue.currentStatus, to: issue.expectedStatus },
    });
    if (issue.expectedStatus === 'available') {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId: args.tenantId,
        unitId: issue.unitId,
      } satisfies UnitAvailablePayload);
    }
    return issue;
  }

  async findIssues(
    tenantId: string,
    facilityScope?: string[] | null,
  ): Promise<InventoryIssueDto[]> {
    // Alcance por local: sin esto, un staff restringido a un local vería
    // descuadres de inventario de CUALQUIER otro local del tenant (solo
    // lectura, pero es información de negocio ajena a su alcance).
    const facFilter = resolveFacilityFilter(facilityScope);
    if (facFilter === null) return [];
    const find = (where: Prisma.UnitWhereInput) =>
      this.admin.unit.findMany({
        where: {
          tenantId,
          facility: { deletedAt: null },
          ...(facFilter ? { facilityId: { in: facFilter } } : {}),
          ...where,
        },
        include: INCLUDE,
      }) as Promise<UnitRow[]>;

    // (1) Ocupado pero sin ningún contrato vivo → debería estar disponible.
    const occupiedNoContract = await find({
      status: 'occupied',
      contracts: { none: LIVE_CONTRACT },
    });
    // (2) Disponible pero con un contrato vivo → debería estar ocupado.
    const availableWithContract = await find({
      status: 'available',
      contracts: { some: LIVE_CONTRACT },
    });
    // (3) Reservado sin reserva viva ni hold de booking (contrato draft) → disponible.
    const reservedOrphan = await find({
      status: 'reserved',
      reservations: { none: { status: { in: ['pending', 'confirmed'] } } },
      contracts: { none: { status: { in: ['draft', 'active', 'ending'] }, deletedAt: null } },
    });

    return [
      ...occupiedNoContract.map((u) =>
        toIssue(u, 'available', 'Ocupado sin ningún contrato activo'),
      ),
      ...availableWithContract.map((u) =>
        toIssue(u, 'occupied', 'Disponible pero con un contrato activo'),
      ),
      ...reservedOrphan.map((u) =>
        toIssue(u, 'available', 'Reservado sin reserva ni contrato en curso'),
      ),
    ];
  }
}
