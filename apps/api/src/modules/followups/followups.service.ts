import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { customerScopeWhere } from '../../common/customer-scope';
import { type FacilityScope } from '../../common/facility-scope';
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
    status: r.status as CustomerFollowupDto['status'],
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    authorName: r.user?.fullName ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Seguimientos/recordatorios del staff sobre inquilinos (CRM ligero). */
@Injectable()
export class FollowupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Que el usuario pueda ver al inquilino (alcance por local) y que no esté borrado. */
  private visible(scope: FacilityScope) {
    return { customer: { deletedAt: null, ...customerScopeWhere(scope ?? null) } };
  }

  /** Bandeja: los pendientes de los inquilinos que ve, los más urgentes primero. */
  async listPending(tenantId: string, scope?: FacilityScope): Promise<CustomerFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findMany({
          where: { status: 'pending', ...this.visible(scope) },
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
    scope?: FacilityScope;
  }): Promise<CustomerFollowupDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findFirst({
          where: { id: args.id, ...this.visible(args.scope) },
          select: { id: true },
        }),
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

  async remove(tenantId: string, id: string, scope?: FacilityScope): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findFirst({
          where: { id, ...this.visible(scope) },
          select: { id: true },
        }),
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
