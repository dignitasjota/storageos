import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaService } from '../database/prisma.service';

import type {
  CreateCustomerFollowupInput,
  CustomerFollowupDto,
  UpdateCustomerFollowupInput,
} from '@storageos/shared';

const include = {
  customer: {
    select: { customerType: true, firstName: true, lastName: true, companyName: true },
  },
  user: { select: { fullName: true } },
} satisfies Prisma.CustomerFollowupInclude;

type Row = Prisma.CustomerFollowupGetPayload<{ include: typeof include }>;

function customerName(c: Row['customer']): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function toDto(r: Row): CustomerFollowupDto {
  return {
    id: r.id,
    customerId: r.customerId,
    customerName: customerName(r.customer),
    title: r.title,
    note: r.note,
    dueDate: r.dueDate.toISOString().slice(0, 10),
    status: r.status as 'pending' | 'done',
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    authorName: r.user?.fullName ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Seguimientos/recordatorios del staff sobre inquilinos (CRM ligero). */
@Injectable()
export class FollowupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bandeja: todos los pendientes del tenant, los más urgentes primero. */
  async listPending(tenantId: string): Promise<CustomerFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findMany({
          where: { status: 'pending' },
          orderBy: [{ dueDate: 'asc' }],
          include,
          take: 200,
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<CustomerFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findMany({
          where: { customerId },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
          include,
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: CreateCustomerFollowupInput;
  }): Promise<CustomerFollowupDto> {
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.create({
          data: {
            tenantId: args.tenantId,
            customerId: args.customerId,
            userId: args.userId,
            title: args.input.title,
            note: args.input.note ?? null,
            dueDate: new Date(args.input.dueDate),
          },
          include,
        }),
      args.tenantId,
    );
    return toDto(created);
  }

  async setStatus(args: {
    tenantId: string;
    id: string;
    input: UpdateCustomerFollowupInput;
  }): Promise<CustomerFollowupDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.customerFollowup.findFirst({ where: { id: args.id }, select: { id: true } }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.update({
          where: { id: args.id },
          data: {
            status: args.input.status,
            completedAt: args.input.status === 'done' ? new Date() : null,
          },
          include,
        }),
      args.tenantId,
    );
    return toDto(updated);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.customerFollowup.findFirst({ where: { id }, select: { id: true } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    await this.prisma.withTenant((tx) => tx.customerFollowup.delete({ where: { id } }), tenantId);
  }
}
