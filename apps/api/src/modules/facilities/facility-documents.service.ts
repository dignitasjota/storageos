import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { FacilityDocument } from '@storageos/database';
import type {
  CreateFacilityDocumentInput,
  FacilityDocumentDto,
  FacilityDocumentKind,
  FacilityDocumentUploadDto,
  UpdateFacilityDocumentInput,
} from '@storageos/shared';

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const DAY = 86_400_000;

function daysTo(date: Date | null): number | null {
  if (!date) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((date.getTime() - todayUtc) / DAY);
}

/**
 * Documentos internos de un local (licencias, seguros, contrato de la nave,
 * inspecciones). Van al almacenamiento privado; se descargan con un enlace
 * firmado y avisan antes de caducar.
 */
@Injectable()
export class FacilityDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  private prefix(tenantId: string, facilityId: string): string {
    return `${tenantId}/facilities/${facilityId}/documents/`;
  }

  private async assertFacility(tenantId: string, facilityId: string): Promise<void> {
    const f = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({ where: { id: facilityId, deletedAt: null }, select: { id: true } }),
      tenantId,
    );
    if (!f)
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
  }

  async list(tenantId: string, facilityId: string): Promise<FacilityDocumentDto[]> {
    await this.assertFacility(tenantId, facilityId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.facilityDocument.findMany({
          where: { facilityId },
          include: { uploadedBy: { select: { fullName: true } } },
          orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r, r.uploadedBy?.fullName ?? null));
  }

  async requestUpload(args: {
    tenantId: string;
    facilityId: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<FacilityDocumentUploadDto> {
    await this.assertFacility(args.tenantId, args.facilityId);
    const key = `${this.prefix(args.tenantId, args.facilityId)}${randomUUID()}.${EXTENSIONS[args.mimeType] ?? 'bin'}`;
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: args.mimeType,
      contentLengthRange: { min: 1, max: args.sizeBytes },
    });
    return { uploadUrl, key, expiresIn, requiredHeaders: { 'Content-Type': args.mimeType } };
  }

  async create(args: {
    tenantId: string;
    userId: string;
    facilityId: string;
    input: CreateFacilityDocumentInput;
  }): Promise<FacilityDocumentDto> {
    await this.assertFacility(args.tenantId, args.facilityId);
    if (!args.input.key.startsWith(this.prefix(args.tenantId, args.facilityId))) {
      throw new BadRequestException({
        code: 'invalid_document_key',
        message: 'El fichero no pertenece a este local',
      });
    }
    // Los bytes reales, no solo el tipo declarado al pedir la subida.
    await this.files.assertObjectMimeType('uploads', args.input.key, [args.input.mimeType]);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.facilityDocument.create({
          data: {
            tenantId: args.tenantId,
            facilityId: args.facilityId,
            kind: args.input.kind,
            name: args.input.name,
            fileKey: args.input.key,
            mimeType: args.input.mimeType,
            sizeBytes: args.input.sizeBytes,
            expiresOn: args.input.expiresOn ? new Date(`${args.input.expiresOn}T00:00:00Z`) : null,
            notes: args.input.notes?.trim() || null,
            uploadedByUserId: args.userId,
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.document_added',
      entityType: 'Facility',
      entityId: args.facilityId,
      changes: { documentId: row.id, kind: row.kind, name: row.name },
    });
    return this.toDto(row, null);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    facilityId: string;
    documentId: string;
    input: UpdateFacilityDocumentInput;
  }): Promise<FacilityDocumentDto> {
    await this.find(args.tenantId, args.facilityId, args.documentId);
    const i = args.input;
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.facilityDocument.update({
          where: { id: args.documentId },
          data: {
            ...(i.kind !== undefined ? { kind: i.kind } : {}),
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.notes !== undefined ? { notes: i.notes.trim() || null } : {}),
            ...(i.expiresOn !== undefined
              ? {
                  expiresOn: i.expiresOn ? new Date(`${i.expiresOn}T00:00:00Z`) : null,
                  // Otra fecha: se vuelve a avisar antes de que caduque.
                  expiryNotifiedAt: null,
                }
              : {}),
          },
          include: { uploadedBy: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    return this.toDto(row, row.uploadedBy?.fullName ?? null);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    facilityId: string;
    documentId: string;
  }): Promise<void> {
    const doc = await this.find(args.tenantId, args.facilityId, args.documentId);
    await this.prisma.withTenant(
      (tx) => tx.facilityDocument.delete({ where: { id: doc.id } }),
      args.tenantId,
    );
    await this.files.deleteObjects('uploads', [doc.fileKey]).catch(() => undefined);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.document_removed',
      entityType: 'Facility',
      entityId: args.facilityId,
      changes: { documentId: doc.id, name: doc.name },
    });
  }

  async downloadUrl(
    tenantId: string,
    facilityId: string,
    documentId: string,
  ): Promise<{ url: string }> {
    const doc = await this.find(tenantId, facilityId, documentId);
    const ext = EXTENSIONS[doc.mimeType] ?? 'bin';
    const safe = doc.name.replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]/g, '').trim() || 'documento';
    return {
      url: await this.files.getPresignedGetUrl('uploads', doc.fileKey, 300, `${safe}.${ext}`),
    };
  }

  private async find(
    tenantId: string,
    facilityId: string,
    documentId: string,
  ): Promise<FacilityDocument> {
    const doc = await this.prisma.withTenant(
      (tx) => tx.facilityDocument.findFirst({ where: { id: documentId, facilityId } }),
      tenantId,
    );
    if (!doc) {
      throw new NotFoundException({
        code: 'document_not_found',
        message: 'Documento no encontrado',
      });
    }
    return doc;
  }

  private toDto(r: FacilityDocument, uploadedByName: string | null): FacilityDocumentDto {
    return {
      id: r.id,
      facilityId: r.facilityId,
      kind: r.kind as FacilityDocumentKind,
      name: r.name,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      expiresOn: r.expiresOn ? r.expiresOn.toISOString().slice(0, 10) : null,
      daysToExpiry: daysTo(r.expiresOn),
      notes: r.notes,
      uploadedByName,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
