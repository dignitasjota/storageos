import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { CustomerAuthorizedPerson } from '@storageos/database';
import type { CustomerAuthorizedPersonDto, CustomerAuthorizedPersonInput } from '@storageos/shared';

const emptyToNull = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * Personas a las que el inquilino autoriza a entrar en su trastero, recoger
 * cosas o hacer gestiones en su nombre (familiar, empleado, mudanzas…). El
 * equipo lo comprueba en el mostrador antes de dejar pasar o entregar algo.
 */
@Injectable()
export class CustomerAuthorizedPersonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, customerId: string): Promise<CustomerAuthorizedPersonDto[]> {
    await this.assertCustomer(tenantId, customerId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerAuthorizedPerson.findMany({
          where: { customerId },
          orderBy: { createdAt: 'asc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    /** null cuando lo añade el propio inquilino desde su área de clientes. */
    userId: string | null;
    customerId: string;
    input: CustomerAuthorizedPersonInput;
  }): Promise<CustomerAuthorizedPersonDto> {
    await this.assertCustomer(args.tenantId, args.customerId);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.customerAuthorizedPerson.create({
          data: {
            tenantId: args.tenantId,
            customerId: args.customerId,
            createdByUserId: args.userId,
            ...this.data(args.input),
          },
        }),
      args.tenantId,
    );
    await this.trace(args, 'customer.authorized_person_added', row.id);
    return this.toDto(row);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    id: string;
    input: CustomerAuthorizedPersonInput;
  }): Promise<CustomerAuthorizedPersonDto> {
    await this.findOrThrow(args.tenantId, args.customerId, args.id);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.customerAuthorizedPerson.update({
          where: { id: args.id },
          data: this.data(args.input),
        }),
      args.tenantId,
    );
    await this.trace(args, 'customer.authorized_person_updated', row.id);
    return this.toDto(row);
  }

  async remove(args: {
    tenantId: string;
    userId: string | null;
    customerId: string;
    id: string;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.customerId, args.id);
    await this.prisma.withTenant(
      (tx) => tx.customerAuthorizedPerson.delete({ where: { id: args.id } }),
      args.tenantId,
    );
    await this.trace(args, 'customer.authorized_person_removed', args.id);
  }

  private data(input: CustomerAuthorizedPersonInput) {
    return {
      fullName: input.fullName.trim(),
      documentNumber: emptyToNull(input.documentNumber),
      phone: emptyToNull(input.phone),
      relationship: emptyToNull(input.relationship),
      canAccess: input.canAccess,
      canPickup: input.canPickup,
      canManage: input.canManage,
      notes: emptyToNull(input.notes),
    };
  }

  private async trace(
    args: { tenantId: string; userId: string | null; customerId: string },
    action: string,
    id: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'Customer',
      entityId: args.customerId,
      changes: { authorizedPersonId: id },
    });
  }

  private async assertCustomer(tenantId: string, customerId: string): Promise<void> {
    const c = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } }),
      tenantId,
    );
    if (!c) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
  }

  private async findOrThrow(
    tenantId: string,
    customerId: string,
    id: string,
  ): Promise<CustomerAuthorizedPerson> {
    const row = await this.prisma.withTenant(
      (tx) => tx.customerAuthorizedPerson.findFirst({ where: { id, customerId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'authorized_person_not_found',
        message: 'Persona autorizada no encontrada',
      });
    }
    return row;
  }

  private toDto(r: CustomerAuthorizedPerson): CustomerAuthorizedPersonDto {
    return {
      id: r.id,
      customerId: r.customerId,
      fullName: r.fullName,
      documentNumber: r.documentNumber,
      phone: r.phone,
      relationship: r.relationship,
      canAccess: r.canAccess,
      canPickup: r.canPickup,
      canManage: r.canManage,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
