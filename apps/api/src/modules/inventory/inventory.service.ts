import { Injectable } from '@nestjs/common';

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
  constructor(private readonly admin: PrismaAdminService) {}

  async findIssues(tenantId: string): Promise<InventoryIssueDto[]> {
    const find = (where: Prisma.UnitWhereInput) =>
      this.admin.unit.findMany({ where: { tenantId, ...where }, include: INCLUDE }) as Promise<
        UnitRow[]
      >;

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
