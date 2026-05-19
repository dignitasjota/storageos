import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Customer, Prisma } from '@storageos/database';
import type {
  CreateCustomerInput,
  CustomerDto,
  SetKycVerifiedInput,
  UpdateCustomerInput,
} from '@storageos/shared';

type CustomerWithCounts = Customer & {
  _count?: { contracts: number; reservations: number };
};

function displayName(c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'>) {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

interface ListFilters {
  search?: string;
  includeDeleted?: boolean;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<CustomerDto[]> {
    const where: Prisma.CustomerWhereInput = {};
    if (!filters.includeDeleted) where.deletedAt = null;
    if (filters.search) {
      const q = filters.search;
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { documentNumber: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          include: {
            _count: {
              select: {
                contracts: { where: { status: { in: ['active', 'ending'] } } },
                reservations: { where: { status: { in: ['pending', 'confirmed'] } } },
              },
            },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, customerId: string): Promise<CustomerDto> {
    const row = await this.findOrThrow(tenantId, customerId);
    return this.toDto(row);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateCustomerInput;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    const data: Prisma.CustomerUncheckedCreateInput = {
      tenantId: args.tenantId,
      customerType: args.input.customerType,
      firstName: args.input.firstName?.trim() || null,
      lastName: args.input.lastName?.trim() || null,
      companyName: args.input.companyName?.trim() || null,
      documentType: args.input.documentType?.trim() || null,
      documentNumber: args.input.documentNumber?.trim() || null,
      email: args.input.email?.trim() || null,
      phone: args.input.phone?.trim() || null,
      address: args.input.address?.trim() || null,
      city: args.input.city?.trim() || null,
      postalCode: args.input.postalCode?.trim() || null,
      country: args.input.country,
      emergencyContactName: args.input.emergencyContactName?.trim() || null,
      emergencyContactPhone: args.input.emergencyContactPhone?.trim() || null,
      notes: args.input.notes?.trim() || null,
      tags: args.input.tags,
    };
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.customer.create({
          data,
          include: { _count: { select: { contracts: true, reservations: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.created',
      entityType: 'Customer',
      entityId: created.id,
      changes: { displayName: displayName(created) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: UpdateCustomerInput;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    await this.findOrThrow(args.tenantId, args.customerId);
    const data: Prisma.CustomerUpdateInput = {};
    const changes: Record<string, unknown> = {};
    const set = <K extends keyof UpdateCustomerInput>(key: K) => {
      const value = args.input[key];
      if (value === undefined) return;
      const cleaned = typeof value === 'string' && (value as string).trim() === '' ? null : value;
      (data as Record<string, unknown>)[key] = cleaned;
      changes[key] = cleaned;
    };
    set('customerType');
    set('firstName');
    set('lastName');
    set('companyName');
    set('documentType');
    set('documentNumber');
    set('email');
    set('phone');
    set('address');
    set('city');
    set('postalCode');
    set('country');
    set('emergencyContactName');
    set('emergencyContactPhone');
    set('notes');
    if (args.input.tags !== undefined) {
      data.tags = args.input.tags;
      changes.tags = args.input.tags;
    }

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data,
          include: { _count: { select: { contracts: true, reservations: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.updated',
      entityType: 'Customer',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async softDelete(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    meta: RequestMeta;
  }): Promise<void> {
    const existing = await this.findOrThrow(args.tenantId, args.customerId);
    // No bloqueamos si tiene contratos: el soft delete preserva el historial.
    await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data: { deletedAt: new Date() },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.deleted',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { displayName: displayName(existing) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  async setKycVerified(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: SetKycVerifiedInput;
    meta: RequestMeta;
  }): Promise<CustomerDto> {
    await this.findOrThrow(args.tenantId, args.customerId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.customer.update({
          where: { id: args.customerId },
          data: {
            kycVerified: args.input.verified,
            kycVerifiedAt: args.input.verified ? new Date() : null,
          },
          include: { _count: { select: { contracts: true, reservations: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.input.verified ? 'customer.kyc_verified' : 'customer.kyc_revoked',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { notes: args.input.notes ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  private async findOrThrow(tenantId: string, customerId: string): Promise<CustomerWithCounts> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: customerId, deletedAt: null },
          include: {
            _count: {
              select: {
                contracts: { where: { status: { in: ['active', 'ending'] } } },
                reservations: { where: { status: { in: ['pending', 'confirmed'] } } },
              },
            },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    return row;
  }

  private toDto(row: CustomerWithCounts): CustomerDto {
    return {
      id: row.id,
      customerType: row.customerType,
      firstName: row.firstName,
      lastName: row.lastName,
      companyName: row.companyName,
      displayName: displayName(row),
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      email: row.email,
      phone: row.phone,
      address: row.address,
      city: row.city,
      postalCode: row.postalCode,
      country: row.country,
      emergencyContactName: row.emergencyContactName,
      emergencyContactPhone: row.emergencyContactPhone,
      notes: row.notes,
      tags: row.tags,
      kycVerified: row.kycVerified,
      kycVerifiedAt: row.kycVerifiedAt ? row.kycVerifiedAt.toISOString() : null,
      activeContracts: row._count?.contracts ?? 0,
      pendingReservations: row._count?.reservations ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
