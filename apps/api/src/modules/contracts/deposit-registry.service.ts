import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { ContractDto, UpdateDepositRegistryInput } from '@storageos/shared';

type Scope = string[] | null | undefined;

const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * Depósito de la fianza de una vivienda en el organismo de la comunidad
 * autónoma (art. 36.6 LAU): organismo, fecha, nº de resguardo, justificante
 * (en el bucket privado) y cuándo se recuperó.
 */
@Injectable()
export class DepositRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  private receiptPrefix(tenantId: string, contractId: string): string {
    return `${tenantId}/contracts/${contractId}/deposit-registry/`;
  }

  async requestUploadUrl(
    tenantId: string,
    contractId: string,
    mimeType: string,
    scope?: Scope,
  ): Promise<{
    uploadUrl: string;
    expiresIn: number;
    key: string;
    requiredHeaders: Record<string, string>;
  }> {
    await this.contracts.detail(tenantId, contractId, scope);
    const key = `${this.receiptPrefix(tenantId, contractId)}${randomUUID()}.${EXT[mimeType] ?? 'pdf'}`;
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, expiresIn, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: UpdateDepositRegistryInput;
    scope?: Scope;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const contract = await this.contracts.detail(args.tenantId, args.contractId, args.scope);
    if (contract.propertyKind !== 'housing') {
      throw new BadRequestException({
        code: 'not_housing',
        message: 'El depósito de la fianza solo aplica a viviendas',
      });
    }
    if (
      args.input.receiptKey &&
      !args.input.receiptKey.startsWith(this.receiptPrefix(args.tenantId, args.contractId))
    ) {
      throw new BadRequestException({
        code: 'invalid_receipt_key',
        message: 'Justificante no válido',
      });
    }
    const day = (v: string) => new Date(`${v}T00:00:00.000Z`);
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: {
            depositRegistryBody: args.input.body,
            depositRegisteredAt: day(args.input.registeredAt),
            depositRegistryReference: args.input.reference?.trim() || null,
            ...(args.input.receiptKey ? { depositRegistryReceiptKey: args.input.receiptKey } : {}),
            ...(args.input.recoveredAt !== undefined
              ? {
                  depositRegistryRecoveredAt: args.input.recoveredAt
                    ? day(args.input.recoveredAt)
                    : null,
                }
              : {}),
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.deposit_registered',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: {
        body: args.input.body,
        registeredAt: args.input.registeredAt,
        recoveredAt: args.input.recoveredAt ?? null,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.contracts.detail(args.tenantId, args.contractId, args.scope);
  }

  async receiptUrl(tenantId: string, contractId: string, scope?: Scope): Promise<{ url: string }> {
    await this.contracts.detail(tenantId, contractId, scope);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findUnique({
          where: { id: contractId },
          select: { depositRegistryReceiptKey: true },
        }),
      tenantId,
    );
    if (!row?.depositRegistryReceiptKey) {
      throw new NotFoundException({ code: 'receipt_not_found', message: 'No hay justificante' });
    }
    return { url: await this.files.getPresignedGetUrl('uploads', row.depositRegistryReceiptKey) };
  }
}
