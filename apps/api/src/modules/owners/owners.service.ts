import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { isUniqueViolation } from '../../common/prisma-errors';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { Owner, Prisma } from '@storageos/database';
import type { CreateOwnerInput, OwnerDto, UpdateOwnerInput } from '@storageos/shared';

const emptyToNull = (v: string) => v.trim() || null;

/** Propietarios del plan Administrador (cada local pertenece a uno). */
@Injectable()
export class OwnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<OwnerDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.owner.findMany({
          orderBy: [{ isActive: 'desc' }, { legalName: 'asc' }],
          include: { _count: { select: { facilities: { where: { deletedAt: null } } } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r, r._count.facilities));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateOwnerInput;
  }): Promise<OwnerDto> {
    const data: Prisma.OwnerUncheckedCreateInput = {
      tenantId: args.tenantId,
      legalName: args.input.legalName,
      taxId: args.input.taxId,
      address: args.input.address ? emptyToNull(args.input.address) : null,
      city: args.input.city ? emptyToNull(args.input.city) : null,
      postalCode: args.input.postalCode ? emptyToNull(args.input.postalCode) : null,
      email: args.input.email ? emptyToNull(args.input.email) : null,
      phone: args.input.phone ? emptyToNull(args.input.phone) : null,
      feeType: args.input.feeType,
      feeValue: args.input.feeValue,
      notes: args.input.notes ? emptyToNull(args.input.notes) : null,
      ...this.ibanData(args.tenantId, args.input.iban),
    };
    const row = await this.prisma
      .withTenant((tx) => tx.owner.create({ data }), args.tenantId)
      .catch((err: unknown) => {
        throw this.mapUnique(err);
      });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'owner.created',
      entityType: 'Owner',
      entityId: row.id,
      changes: { legalName: row.legalName, taxId: row.taxId },
    });
    return this.toDto(row, 0);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    ownerId: string;
    input: UpdateOwnerInput;
  }): Promise<OwnerDto> {
    await this.findOrThrow(args.tenantId, args.ownerId);
    const i = args.input;
    const data: Prisma.OwnerUncheckedUpdateInput = {
      ...(i.legalName !== undefined ? { legalName: i.legalName } : {}),
      ...(i.taxId !== undefined ? { taxId: i.taxId } : {}),
      ...(i.address !== undefined ? { address: emptyToNull(i.address) } : {}),
      ...(i.city !== undefined ? { city: emptyToNull(i.city) } : {}),
      ...(i.postalCode !== undefined ? { postalCode: emptyToNull(i.postalCode) } : {}),
      ...(i.email !== undefined ? { email: emptyToNull(i.email) } : {}),
      ...(i.phone !== undefined ? { phone: emptyToNull(i.phone) } : {}),
      ...(i.feeType !== undefined ? { feeType: i.feeType } : {}),
      ...(i.feeValue !== undefined ? { feeValue: i.feeValue } : {}),
      ...(i.notes !== undefined ? { notes: emptyToNull(i.notes) } : {}),
      ...(i.isActive !== undefined ? { isActive: i.isActive } : {}),
      ...(i.iban !== undefined ? this.ibanData(args.tenantId, i.iban) : {}),
    };
    const row = await this.prisma
      .withTenant((tx) => tx.owner.update({ where: { id: args.ownerId }, data }), args.tenantId)
      .catch((err: unknown) => {
        throw this.mapUnique(err);
      });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'owner.updated',
      entityType: 'Owner',
      entityId: row.id,
      changes: { ...i, iban: i.iban !== undefined ? '(cambiado)' : undefined },
    });
    const count = await this.prisma.withTenant(
      (tx) => tx.facility.count({ where: { ownerId: row.id, deletedAt: null } }),
      args.tenantId,
    );
    return this.toDto(row, count);
  }

  /** El propietario existe y es del tenant (404 si no). */
  async findOrThrow(tenantId: string, ownerId: string): Promise<Owner> {
    const row = await this.prisma.withTenant(
      (tx) => tx.owner.findFirst({ where: { id: ownerId, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'owner_not_found',
        message: 'Propietario no encontrado',
      });
    }
    return row;
  }

  private ibanData(tenantId: string, iban: string | undefined) {
    if (iban === undefined) return {};
    if (!iban) return { ibanEncrypted: null, ibanLast4: null };
    return { ibanEncrypted: this.crypto.encryptString(iban, tenantId), ibanLast4: iban.slice(-4) };
  }

  private mapUnique(err: unknown): unknown {
    if (isUniqueViolation(err)) {
      return new ConflictException({
        code: 'owner_tax_id_taken',
        message: 'Ya hay un propietario con ese NIF',
      });
    }
    return err;
  }

  private toDto(r: Owner, facilitiesCount: number): OwnerDto {
    return {
      id: r.id,
      legalName: r.legalName,
      taxId: r.taxId,
      address: r.address,
      city: r.city,
      postalCode: r.postalCode,
      email: r.email,
      phone: r.phone,
      ibanLast4: r.ibanLast4,
      feeType: r.feeType === 'fixed' ? 'fixed' : 'percentage',
      feeValue: Number(r.feeValue),
      notes: r.notes,
      isActive: r.isActive,
      facilitiesCount,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
