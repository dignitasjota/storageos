import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaService } from '../database/prisma.service';

import type { CreateCustomerInteractionInput, CustomerInteractionDto } from '@storageos/shared';

const interactionInclude = {
  user: { select: { fullName: true } },
} satisfies Prisma.CustomerInteractionInclude;

type InteractionRow = Prisma.CustomerInteractionGetPayload<{ include: typeof interactionInclude }>;

function toDto(row: InteractionRow): CustomerInteractionDto {
  const userName = row.user?.fullName ?? null;
  return {
    id: row.id,
    type: row.type as CustomerInteractionDto['type'],
    content: row.content,
    occurredAt: row.occurredAt.toISOString(),
    userId: row.userId,
    userName,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class CustomerInteractionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, customerId: string): Promise<CustomerInteractionDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerInteraction.findMany({
          where: { customerId },
          include: interactionInclude,
          orderBy: { occurredAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async create(args: {
    tenantId: string;
    customerId: string;
    userId: string | null;
    input: CreateCustomerInteractionInput;
  }): Promise<CustomerInteractionDto> {
    const { tenantId, customerId, userId, input } = args;
    const created = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      return tx.customerInteraction.create({
        data: {
          tenantId,
          customerId,
          userId,
          type: input.type,
          content: input.content,
          ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
        },
        include: interactionInclude,
      });
    }, tenantId);
    return toDto(created);
  }

  async remove(tenantId: string, customerId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const row = await tx.customerInteraction.findFirst({ where: { id, customerId } });
      if (!row) {
        throw new NotFoundException({
          code: 'interaction_not_found',
          message: 'Interacción no encontrada',
        });
      }
      await tx.customerInteraction.delete({ where: { id } });
    }, tenantId);
  }
}
