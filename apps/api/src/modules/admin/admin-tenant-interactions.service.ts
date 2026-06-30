import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { CreateTenantInteractionInput, TenantInteractionDto } from '@storageos/shared';

const interactionInclude = {
  superAdmin: { select: { fullName: true } },
} satisfies Prisma.TenantInteractionInclude;

type InteractionRow = Prisma.TenantInteractionGetPayload<{ include: typeof interactionInclude }>;

function toDto(row: InteractionRow): TenantInteractionDto {
  return {
    id: row.id,
    type: row.type as TenantInteractionDto['type'],
    content: row.content,
    link: row.link,
    occurredAt: row.occurredAt.toISOString(),
    authorId: row.superAdminId,
    authorName: row.superAdmin?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Histórico de conversaciones del super admin con un tenant (panel admin).
 *
 * Réplica de `CustomerInteractionsService` (panel del tenant) pero a nivel
 * plataforma: el autor es un super admin y se accede vía `PrismaAdminService`
 * (bypassa RLS), igual que los pagos de la suscripción. No hay multi-tenancy
 * que reforzar aquí: el `AdminGuard` ya restringe el acceso al super admin.
 */
@Injectable()
export class AdminTenantInteractionsService {
  constructor(private readonly admin: PrismaAdminService) {}

  async list(tenantId: string): Promise<TenantInteractionDto[]> {
    const rows = await this.admin.tenantInteraction.findMany({
      where: { tenantId },
      include: interactionInclude,
      orderBy: { occurredAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async create(args: {
    tenantId: string;
    superAdminId: string | null;
    input: CreateTenantInteractionInput;
    /** Enlace opcional asociado (p. ej. al ticket de soporte que la originó). */
    link?: string | null;
  }): Promise<TenantInteractionDto> {
    const { tenantId, superAdminId, input, link } = args;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const created = await this.admin.tenantInteraction.create({
      data: {
        tenantId,
        superAdminId,
        type: input.type,
        content: input.content,
        ...(link ? { link } : {}),
        ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
      },
      include: interactionInclude,
    });
    return toDto(created);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const row = await this.admin.tenantInteraction.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'interaction_not_found',
        message: 'Interacción no encontrada',
      });
    }
    await this.admin.tenantInteraction.delete({ where: { id } });
  }
}
