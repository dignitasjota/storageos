import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  CreateTenantFollowupInput,
  TenantFollowupDto,
  TenantFollowupStatusValue,
} from '@storageos/shared';

const followupInclude = {
  superAdmin: { select: { fullName: true } },
  tenant: { select: { name: true, slug: true } },
} satisfies Prisma.TenantFollowupInclude;

type FollowupRow = Prisma.TenantFollowupGetPayload<{ include: typeof followupInclude }>;

function toDto(row: FollowupRow): TenantFollowupDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    tenantSlug: row.tenant.slug,
    title: row.title,
    note: row.note,
    dueDate: row.dueDate.toISOString().slice(0, 10),
    status: row.status as TenantFollowupStatusValue,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    authorName: row.superAdmin?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Seguimientos/recordatorios del super admin sobre los tenants (CRM ligero):
 * tareas con fecha de recordatorio y estado pending/done. Acceso vía
 * `PrismaAdminService` (el `AdminGuard` restringe al super admin).
 */
@Injectable()
export class AdminTenantFollowupsService {
  constructor(private readonly admin: PrismaAdminService) {}

  /** Seguimientos de un tenant concreto (los pendientes primero, por fecha). */
  async listForTenant(tenantId: string): Promise<TenantFollowupDto[]> {
    const rows = await this.admin.tenantFollowup.findMany({
      where: { tenantId },
      include: followupInclude,
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
    return rows.map(toDto);
  }

  /** Bandeja global de pendientes (todos los tenants), por fecha de recordatorio. */
  async listPending(): Promise<TenantFollowupDto[]> {
    const rows = await this.admin.tenantFollowup.findMany({
      where: { status: 'pending', tenant: { deletedAt: null } },
      include: followupInclude,
      orderBy: { dueDate: 'asc' },
    });
    return rows.map(toDto);
  }

  async create(args: {
    tenantId: string;
    superAdminId: string | null;
    input: CreateTenantFollowupInput;
  }): Promise<TenantFollowupDto> {
    const { tenantId, superAdminId, input } = args;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const created = await this.admin.tenantFollowup.create({
      data: {
        tenantId,
        superAdminId,
        title: input.title,
        note: input.note ?? null,
        dueDate: new Date(`${input.dueDate}T00:00:00.000Z`),
      },
      include: followupInclude,
    });
    return toDto(created);
  }

  /** Marca un seguimiento como hecho o lo reabre. */
  async setStatus(id: string, status: TenantFollowupStatusValue): Promise<TenantFollowupDto> {
    const row = await this.admin.tenantFollowup.findUnique({ where: { id }, select: { id: true } });
    if (!row) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    const updated = await this.admin.tenantFollowup.update({
      where: { id },
      data: { status, completedAt: status === 'done' ? new Date() : null },
      include: followupInclude,
    });
    return toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const row = await this.admin.tenantFollowup.findUnique({ where: { id }, select: { id: true } });
    if (!row) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    await this.admin.tenantFollowup.delete({ where: { id } });
  }
}
