import { randomBytes, randomInt } from 'node:crypto';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  AccessCredential,
  AccessCredentialStatus,
  AccessMethod,
  Customer,
  CustomerType,
  Prisma,
} from '@storageos/database';
import type {
  AccessCredentialDto,
  AccessCredentialStatusValue,
  AccessCredentialWithSecretDto,
  AccessMethodValue,
  CreateCredentialInput,
  PortalAccessCredentialDto,
  RotateCredentialInput,
  SuspendCredentialInput,
  UpdateCredentialInput,
} from '@storageos/shared';

interface ListFilters {
  status?: AccessCredentialStatusValue;
  customerId?: string;
  method?: AccessMethodValue;
}

type CredentialWithCustomer = AccessCredential & {
  customer?: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null;
};

const CUSTOMER_SELECT = {
  customer: {
    select: {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
} satisfies Prisma.AccessCredentialInclude;

function customerDisplay(
  c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null | undefined,
): string {
  if (!c) return 'Cliente';
  if (c.customerType === ('business' as CustomerType)) return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

function generateRandomPin(): string {
  // 6 digitos: [100000, 999999]
  return randomInt(100000, 1000000).toString();
}

function generateQrToken(): string {
  // 24 chars base64url ~ 18 bytes
  return randomBytes(18).toString('base64url');
}

@Injectable()
export class AccessCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<AccessCredentialDto[]> {
    const where: Prisma.AccessCredentialWhereInput = {};
    if (filters.status) where.status = filters.status as AccessCredentialStatus;
    if (filters.method) where.method = filters.method as AccessMethod;
    if (filters.customerId) where.customerId = filters.customerId;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where,
          include: CUSTOMER_SELECT,
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<AccessCredentialDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateCredentialInput;
    meta: RequestMeta;
  }): Promise<AccessCredentialWithSecretDto> {
    const input = args.input;
    let secretHash: string | null = null;
    let secretPreview: string | null = null;
    let rfidUid: string | null = null;
    let revealedSecret: string | null = null;

    let secretEncrypted: string | null = null;
    if (input.method === 'pin') {
      const pin = input.pin ?? generateRandomPin();
      secretHash = await argonHash(pin);
      secretPreview = pin.slice(-4);
      secretEncrypted = this.crypto.encryptString(pin);
      revealedSecret = pin;
    } else if (input.method === 'qr') {
      const token = generateQrToken();
      secretHash = await argonHash(token);
      secretPreview = token.slice(0, 4);
      secretEncrypted = this.crypto.encryptString(token);
      revealedSecret = token;
    } else {
      // rfid (schema garantiza rfidUid presente)
      if (!input.rfidUid) {
        throw new ConflictException({
          code: 'rfid_uid_required',
          message: 'rfidUid requerido cuando method=rfid',
        });
      }
      rfidUid = input.rfidUid;
    }

    const now = new Date();
    const data: Prisma.AccessCredentialUncheckedCreateInput = {
      tenantId: args.tenantId,
      customerId: input.customerId,
      method: input.method as AccessMethod,
      status: 'active' as AccessCredentialStatus,
      label: input.label?.trim() || null,
      secretHash,
      secretPreview,
      secretEncrypted,
      rfidUid,
      allowedFacilityIds: input.allowedFacilityIds,
      allowedUnitIds: input.allowedUnitIds,
      allowedHours: input.allowedHours as Prisma.InputJsonValue,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      contractId: input.contractId ?? null,
      metadata: input.metadata as Prisma.InputJsonValue,
      activatedAt: now,
    };
    const created = await this.prisma.withTenant(
      (tx) => tx.accessCredential.create({ data, include: CUSTOMER_SELECT }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_created', args, created.id);
    return { ...this.toDto(created), revealedSecret };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateCredentialInput;
    meta: RequestMeta;
  }): Promise<AccessCredentialDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.AccessCredentialUncheckedUpdateInput = {};
    const input = args.input;
    if (input.label !== undefined) data.label = input.label?.trim() || null;
    if (input.allowedFacilityIds !== undefined)
      data.allowedFacilityIds = { set: input.allowedFacilityIds };
    if (input.allowedUnitIds !== undefined) data.allowedUnitIds = { set: input.allowedUnitIds };
    if (input.allowedHours !== undefined)
      data.allowedHours = input.allowedHours as Prisma.InputJsonValue;
    if (input.expiresAt !== undefined)
      data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (input.metadata !== undefined) data.metadata = input.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.update({
          where: { id: args.id },
          data,
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_updated', args, args.id);
    return this.toDto(updated);
  }

  async rotate(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: RotateCredentialInput;
    meta: RequestMeta;
  }): Promise<AccessCredentialWithSecretDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    if (existing.status === ('revoked' as AccessCredentialStatus)) {
      throw new ConflictException({
        code: 'credential_revoked',
        message: 'No se puede rotar una credencial revocada',
      });
    }
    const data: Prisma.AccessCredentialUncheckedUpdateInput = {};
    let revealedSecret: string | null = null;

    if (existing.method === ('pin' as AccessMethod)) {
      const pin = args.input.pin ?? generateRandomPin();
      data.secretHash = await argonHash(pin);
      data.secretPreview = pin.slice(-4);
      data.secretEncrypted = this.crypto.encryptString(pin);
      revealedSecret = pin;
    } else if (existing.method === ('qr' as AccessMethod)) {
      const token = generateQrToken();
      data.secretHash = await argonHash(token);
      data.secretPreview = token.slice(0, 4);
      data.secretEncrypted = this.crypto.encryptString(token);
      revealedSecret = token;
    } else {
      // rfid
      if (!args.input.rfidUid) {
        throw new ConflictException({
          code: 'rfid_uid_required',
          message: 'rfidUid requerido para rotar credencial rfid',
        });
      }
      data.rfidUid = args.input.rfidUid;
      revealedSecret = null;
    }

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.update({
          where: { id: args.id },
          data,
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_rotated', args, args.id);
    return { ...this.toDto(updated), revealedSecret };
  }

  async suspend(args: {
    tenantId: string;
    userId: string;
    id?: string;
    customerId?: string;
    input: SuspendCredentialInput;
    meta: RequestMeta;
  }): Promise<AccessCredentialDto[]> {
    if (!args.id && !args.customerId) {
      throw new ConflictException({
        code: 'suspend_target_required',
        message: 'Debes indicar id o customerId',
      });
    }
    const where: Prisma.AccessCredentialWhereInput = {
      status: 'active' as AccessCredentialStatus,
    };
    if (args.id) where.id = args.id;
    if (args.customerId) where.customerId = args.customerId;

    const now = new Date();
    const rows = await this.prisma.withTenant(async (tx) => {
      const result = await tx.accessCredential.updateMany({
        where,
        data: {
          status: 'suspended' as AccessCredentialStatus,
          suspendedAt: now,
          suspendReason: args.input.reason,
        },
      });
      if (result.count === 0) return [];
      const target: Prisma.AccessCredentialWhereInput = {
        status: 'suspended' as AccessCredentialStatus,
      };
      if (args.id) target.id = args.id;
      if (args.customerId) target.customerId = args.customerId;
      return tx.accessCredential.findMany({
        where: target,
        include: CUSTOMER_SELECT,
      });
    }, args.tenantId);

    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'No se encontraron credenciales para suspender',
      });
    }
    for (const r of rows) {
      await this.writeAudit('access.credential_suspended', args, r.id);
    }
    return rows.map((r) => this.toDto(r));
  }

  async resume(args: {
    tenantId: string;
    userId: string;
    id?: string;
    customerId?: string;
    meta: RequestMeta;
  }): Promise<AccessCredentialDto[]> {
    if (!args.id && !args.customerId) {
      throw new ConflictException({
        code: 'resume_target_required',
        message: 'Debes indicar id o customerId',
      });
    }
    const where: Prisma.AccessCredentialWhereInput = {
      status: 'suspended' as AccessCredentialStatus,
    };
    if (args.id) where.id = args.id;
    if (args.customerId) where.customerId = args.customerId;

    const rows = await this.prisma.withTenant(async (tx) => {
      const result = await tx.accessCredential.updateMany({
        where,
        data: {
          status: 'active' as AccessCredentialStatus,
          suspendedAt: null,
          suspendReason: null,
        },
      });
      if (result.count === 0) return [];
      const target: Prisma.AccessCredentialWhereInput = {
        status: 'active' as AccessCredentialStatus,
      };
      if (args.id) target.id = args.id;
      if (args.customerId) target.customerId = args.customerId;
      return tx.accessCredential.findMany({
        where: target,
        include: CUSTOMER_SELECT,
      });
    }, args.tenantId);

    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'No se encontraron credenciales suspendidas',
      });
    }
    for (const r of rows) {
      await this.writeAudit('access.credential_resumed', args, r.id);
    }
    return rows.map((r) => this.toDto(r));
  }

  async revoke(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<AccessCredentialDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    if (existing.status === ('revoked' as AccessCredentialStatus)) {
      throw new ConflictException({
        code: 'credential_already_revoked',
        message: 'La credencial ya esta revocada',
      });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.update({
          where: { id: args.id },
          data: {
            status: 'revoked' as AccessCredentialStatus,
            revokedAt: new Date(),
          },
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_revoked', args, args.id);
    return this.toDto(updated);
  }

  // ===================== portal del inquilino =============================

  /**
   * Credenciales pin/qr ACTIVAS del inquilino, con el valor descifrado para
   * que pueda mostrarlas/presentarlas en el lector. RFID excluido (es física).
   */
  async listForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<PortalAccessCredentialDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            customerId,
            status: 'active' as AccessCredentialStatus,
            method: { in: ['pin', 'qr'] as AccessMethod[] },
          },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      method: r.method as 'pin' | 'qr',
      label: r.label,
      status: r.status,
      value: r.secretEncrypted ? this.crypto.decryptString(r.secretEncrypted) : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }));
  }

  /**
   * El inquilino regenera el secreto de SU credencial (p. ej. si lo cree
   * comprometido, o para obtener un valor visible en una credencial antigua).
   * Verifica la propiedad por `customerId` antes de rotar.
   */
  async regenerateForCustomer(
    tenantId: string,
    customerId: string,
    credentialId: string,
  ): Promise<PortalAccessCredentialDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.accessCredential.findFirst({ where: { id: credentialId, customerId } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'Credencial no encontrada',
      });
    }
    if (existing.status !== ('active' as AccessCredentialStatus)) {
      throw new ConflictException({
        code: 'credential_not_active',
        message: 'Solo se puede regenerar una credencial activa',
      });
    }
    if (existing.method !== ('pin' as AccessMethod) && existing.method !== ('qr' as AccessMethod)) {
      throw new ConflictException({
        code: 'credential_not_regenerable',
        message: 'Solo PIN o QR son regenerables desde el portal',
      });
    }

    const data: Prisma.AccessCredentialUncheckedUpdateInput = {};
    if (existing.method === ('pin' as AccessMethod)) {
      const pin = generateRandomPin();
      data.secretHash = await argonHash(pin);
      data.secretPreview = pin.slice(-4);
      data.secretEncrypted = this.crypto.encryptString(pin);
    } else {
      const token = generateQrToken();
      data.secretHash = await argonHash(token);
      data.secretPreview = token.slice(0, 4);
      data.secretEncrypted = this.crypto.encryptString(token);
    }
    const updated = await this.prisma.withTenant(
      (tx) => tx.accessCredential.update({ where: { id: credentialId }, data }),
      tenantId,
    );
    return {
      id: updated.id,
      method: updated.method as 'pin' | 'qr',
      label: updated.label,
      status: updated.status,
      value: updated.secretEncrypted ? this.crypto.decryptString(updated.secretEncrypted) : null,
      expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
      lastUsedAt: updated.lastUsedAt ? updated.lastUsedAt.toISOString() : null,
    };
  }

  private async findOrThrow(tenantId: string, id: string): Promise<CredentialWithCustomer> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findFirst({
          where: { id },
          include: CUSTOMER_SELECT,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'Credencial no encontrada',
      });
    }
    return row as CredentialWithCustomer;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'AccessCredential',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(c: CredentialWithCustomer): AccessCredentialDto {
    return {
      id: c.id,
      customerId: c.customerId,
      customerName: customerDisplay(c.customer),
      method: c.method as AccessMethodValue,
      status: c.status as AccessCredentialStatusValue,
      label: c.label,
      secretPreview: c.secretPreview,
      rfidUid: c.rfidUid,
      allowedFacilityIds: c.allowedFacilityIds,
      allowedUnitIds: c.allowedUnitIds,
      allowedHours: (c.allowedHours ?? {}) as Record<string, unknown>,
      suspendReason: c.suspendReason,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      activatedAt: c.activatedAt?.toISOString() ?? null,
      suspendedAt: c.suspendedAt?.toISOString() ?? null,
      revokedAt: c.revokedAt?.toISOString() ?? null,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      contractId: c.contractId,
      metadata: (c.metadata ?? {}) as Record<string, unknown>,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
