import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  CheckoutPhotoDto,
  CheckoutPhotoUploadDto,
  RegisterCheckoutPhotoInput,
  RequestCheckoutPhotoUploadInput,
} from '@storageos/shared';

type Scope = string[] | null | undefined;

/**
 * Fotos de check-out: evidencia del estado del trastero a la salida (fianzas,
 * disputas). Las imágenes se suben directamente a MinIO (bucket privado
 * `uploads`) con URL firmada PUT; aquí guardamos la key + metadatos y servimos
 * las fotos con URLs firmadas GET de corta duración.
 */
@Injectable()
export class CheckoutPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, contractId: string, scope?: Scope): Promise<CheckoutPhotoDto[]> {
    await this.assertContract(tenantId, contractId, scope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contractCheckoutPhoto.findMany({
          where: { contractId },
          orderBy: [{ createdAt: 'desc' }],
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        contractId: r.contractId,
        url: await this.files.getPresignedGetUrl('uploads', r.key),
        note: r.note,
        createdByName: r.createdBy?.fullName ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  }

  async requestUploadUrl(
    tenantId: string,
    contractId: string,
    input: RequestCheckoutPhotoUploadInput,
    scope?: Scope,
  ): Promise<CheckoutPhotoUploadDto> {
    await this.assertContract(tenantId, contractId, scope);
    const key = this.files.buildCheckoutPhotoKey(tenantId, contractId, input.mimeType);
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: input.mimeType,
    });
    return {
      uploadUrl,
      expiresIn,
      requiredHeaders: { 'Content-Type': input.mimeType },
      key,
    };
  }

  async register(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: RegisterCheckoutPhotoInput;
    meta: RequestMeta;
    scope?: Scope;
  }): Promise<CheckoutPhotoDto> {
    await this.assertContract(args.tenantId, args.contractId, args.scope);
    // La key debe pertenecer a este contrato (defensa: que no registren la key
    // de otro tenant/contrato a la que no tendrían URL firmada de subida).
    const prefix = `${args.tenantId}/contracts/${args.contractId}/checkout/`;
    if (!args.input.key.startsWith(prefix)) {
      throw new BadRequestException({ code: 'invalid_photo_key', message: 'Key no válida' });
    }
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.contractCheckoutPhoto.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            key: args.input.key,
            note: args.input.note?.trim() || null,
            createdByUserId: args.userId,
          },
          include: { createdBy: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.checkout_photo_added',
      entityType: 'ContractCheckoutPhoto',
      entityId: created.id,
      changes: { contractId: args.contractId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return {
      id: created.id,
      contractId: created.contractId,
      url: await this.files.getPresignedGetUrl('uploads', created.key),
      note: created.note,
      createdByName: created.createdBy?.fullName ?? null,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async delete(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    photoId: string;
    meta: RequestMeta;
    scope?: Scope;
  }): Promise<void> {
    await this.assertContract(args.tenantId, args.contractId, args.scope);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.contractCheckoutPhoto.findFirst({
          where: { id: args.photoId, contractId: args.contractId },
        }),
      args.tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'photo_not_found', message: 'Foto no encontrada' });
    }
    await this.prisma.withTenant(
      (tx) => tx.contractCheckoutPhoto.delete({ where: { id: args.photoId } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.checkout_photo_deleted',
      entityType: 'ContractCheckoutPhoto',
      entityId: args.photoId,
      changes: { contractId: args.contractId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /** Verifica que el contrato existe en el tenant y está en el scope de locales. */
  private async assertContract(tenantId: string, contractId: string, scope?: Scope): Promise<void> {
    const contract = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: { id: contractId, deletedAt: null },
          include: { unit: { select: { facilityId: true } } },
        }),
      tenantId,
    );
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(scope, contract.unit.facilityId);
  }
}
