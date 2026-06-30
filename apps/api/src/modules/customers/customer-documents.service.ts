import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { RequestMeta } from '../auth/auth.service';
import type { CustomerDocument } from '@storageos/database';
import type {
  CustomerDocumentDto,
  CustomerDocumentUploadDto,
  RegisterCustomerDocumentInput,
  RequestCustomerDocumentUploadInput,
} from '@storageos/shared';

type CustomerDocumentWithUser = CustomerDocument & {
  uploadedBy?: { fullName: string } | null;
};

@Injectable()
export class CustomerDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, customerId: string): Promise<CustomerDocumentDto[]> {
    await this.assertCustomer(tenantId, customerId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerDocument.findMany({
          where: { customerId },
          orderBy: [{ createdAt: 'desc' }],
          include: { uploadedBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async requestUploadUrl(
    tenantId: string,
    customerId: string,
    input: RequestCustomerDocumentUploadInput,
  ): Promise<CustomerDocumentUploadDto> {
    await this.assertCustomer(tenantId, customerId);
    const key = this.files.buildCustomerDocumentKey(
      tenantId,
      customerId,
      input.mimeType,
      input.fileName,
    );
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: input.mimeType,
    });
    return {
      uploadUrl,
      publicUrl: this.files.buildPublicUrl('uploads', key),
      expiresIn,
      requiredHeaders: { 'Content-Type': input.mimeType },
      key,
    };
  }

  async register(args: {
    tenantId: string;
    /** `null` cuando el alta la hace el propio inquilino desde el portal. */
    userId: string | null;
    customerId: string;
    input: RegisterCustomerDocumentInput;
    meta: RequestMeta;
  }): Promise<CustomerDocumentDto> {
    await this.assertCustomer(args.tenantId, args.customerId);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.customerDocument.create({
          data: {
            tenantId: args.tenantId,
            customerId: args.customerId,
            type: args.input.type,
            fileUrl: args.input.fileUrl,
            fileName: args.input.fileName,
            mimeType: args.input.mimeType,
            fileSize: args.input.fileSize,
            uploadedByUserId: args.userId,
            ...(args.input.expiresAt ? { expiresAt: new Date(args.input.expiresAt) } : {}),
          },
          include: { uploadedBy: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer_document.added',
      entityType: 'CustomerDocument',
      entityId: created.id,
      changes: { customerId: args.customerId, type: args.input.type },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async delete(args: {
    tenantId: string;
    userId: string;
    documentId: string;
    meta: RequestMeta;
  }): Promise<void> {
    const row = await this.prisma.withTenant(
      (tx) => tx.customerDocument.findUnique({ where: { id: args.documentId } }),
      args.tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Documento no encontrado',
      });
    }
    await this.prisma.withTenant(
      (tx) => tx.customerDocument.delete({ where: { id: args.documentId } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer_document.deleted',
      entityType: 'CustomerDocument',
      entityId: args.documentId,
      changes: { customerId: row.customerId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  private async assertCustomer(tenantId: string, customerId: string): Promise<void> {
    const c = await this.prisma.withTenant(
      (tx) => tx.customer.findFirst({ where: { id: customerId, deletedAt: null } }),
      tenantId,
    );
    if (!c) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
  }

  private toDto(row: CustomerDocumentWithUser): CustomerDocumentDto {
    return {
      id: row.id,
      customerId: row.customerId,
      type: row.type,
      fileUrl: row.fileUrl,
      fileName: row.fileName,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      uploadedByUserId: row.uploadedByUserId,
      uploadedByName: row.uploadedBy?.fullName ?? null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
