import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SALES_MATERIAL_MAX_BYTES,
  SALES_MATERIAL_MIME_TYPES,
  SalesCadenceStepSchema,
  type SalesCadenceDto,
  type SalesMaterialDto,
  type SalesMaterialKind,
  type SalesMaterialUploadInput,
  type SalesTemplateChannel,
  type SalesTemplateDto,
  type UpsertSalesCadenceInput,
  type UpsertSalesMaterialInput,
  type UpsertSalesTemplateInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { FilesService } from '../../files/files.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { clean } from './sales-common';

import type { Prisma, SalesCadence, SalesMaterial, SalesTemplate } from '@storageos/database';

const MATERIAL_PREFIX = 'platform/sales-materials/';

/**
 * Lo que la dirección prepara para los comerciales: materiales de venta
 * (dossier, tarifas, guion…), plantillas de correo y WhatsApp, y cadencias de
 * contacto. Los comerciales solo los leen.
 */
@Injectable()
export class SalesContentService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ------------------------------------------------------------- materiales

  private materialDto(m: SalesMaterial): SalesMaterialDto {
    return {
      id: m.id,
      title: m.title,
      description: m.description,
      kind: m.kind as SalesMaterialKind,
      url: m.url,
      fileName: m.fileName,
      mimeType: m.mimeType,
      sizeBytes: m.sizeBytes,
      body: m.body,
      position: m.position,
      updatedAt: m.updatedAt.toISOString(),
    };
  }

  async materials(): Promise<SalesMaterialDto[]> {
    const rows = await this.admin.salesMaterial.findMany({
      orderBy: [{ position: 'asc' }, { title: 'asc' }],
    });
    return rows.map((m) => this.materialDto(m));
  }

  async materialUploadUrl(
    input: SalesMaterialUploadInput,
  ): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    const safe = input.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'fichero';
    const key = `${MATERIAL_PREFIX}${randomUUID()}/${safe}`;
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: input.mimeType,
    });
    return { uploadUrl, key, expiresIn };
  }

  async saveMaterial(
    id: string | null,
    input: UpsertSalesMaterialInput,
    byId: string,
  ): Promise<SalesMaterialDto> {
    let file: { fileKey: string; fileName: string; mimeType: string } | null = null;
    if (input.kind === 'file') {
      const key = input.fileKey!;
      if (!key.startsWith(MATERIAL_PREFIX) || key.includes('..')) {
        throw new BadRequestException({ code: 'invalid_file_key', message: 'Fichero no válido' });
      }
      const name = input.fileName ?? key.split('/').pop() ?? 'fichero';
      const mime = this.mimeOf(name);
      await this.files.assertObjectMimeType('uploads', key, [mime], SALES_MATERIAL_MAX_BYTES, {
        mustExist: true,
      });
      file = { fileKey: key, fileName: name, mimeType: mime };
    }
    const data = {
      title: input.title,
      description: clean(input.description),
      kind: input.kind,
      url: input.kind === 'link' ? clean(input.url) : null,
      body: input.kind === 'note' ? clean(input.body) : null,
      position: input.position,
      fileKey: file?.fileKey ?? null,
      fileName: file?.fileName ?? null,
      mimeType: file?.mimeType ?? null,
    };
    let row: SalesMaterial;
    if (id) {
      const before = await this.admin.salesMaterial.findUnique({ where: { id } });
      if (!before)
        throw new NotFoundException({
          code: 'material_not_found',
          message: 'Material no encontrado',
        });
      row = await this.admin.salesMaterial.update({
        where: { id },
        data: input.kind === 'file' && !file ? { ...data, fileKey: before.fileKey } : data,
      });
      if (before.fileKey && before.fileKey !== row.fileKey) {
        await this.files.deleteObjects('uploads', [before.fileKey]);
      }
    } else {
      row = await this.admin.salesMaterial.create({ data: { ...data, createdById: byId } });
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.material_saved',
      targetType: 'platform',
      targetId: null,
      changes: { title: input.title, kind: input.kind },
    });
    return this.materialDto(row);
  }

  private mimeOf(name: string): (typeof SALES_MATERIAL_MIME_TYPES)[number] {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    const map: Record<string, (typeof SALES_MATERIAL_MIME_TYPES)[number]> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const mime = map[ext];
    if (!mime) {
      throw new BadRequestException({
        code: 'invalid_file_type',
        message: 'Sube un PDF, una imagen o un documento de Office',
      });
    }
    return mime;
  }

  async deleteMaterial(id: string, byId: string): Promise<void> {
    const row = await this.admin.salesMaterial.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundException({
        code: 'material_not_found',
        message: 'Material no encontrado',
      });
    await this.admin.salesMaterial.delete({ where: { id } });
    if (row.fileKey) await this.files.deleteObjects('uploads', [row.fileKey]);
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.material_deleted',
      targetType: 'platform',
      targetId: null,
      changes: { title: row.title },
    });
  }

  async materialDownloadUrl(id: string): Promise<{ url: string }> {
    const row = await this.admin.salesMaterial.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundException({
        code: 'material_not_found',
        message: 'Material no encontrado',
      });
    if (row.kind === 'link' && row.url) return { url: row.url };
    if (!row.fileKey) {
      throw new BadRequestException({ code: 'no_file', message: 'Este material no tiene fichero' });
    }
    const url = await this.files.getPresignedGetUrl(
      'uploads',
      row.fileKey,
      300,
      row.fileName ?? undefined,
    );
    return { url };
  }

  // ------------------------------------------------------------- plantillas

  private templateDto(t: SalesTemplate): SalesTemplateDto {
    return {
      id: t.id,
      name: t.name,
      channel: t.channel as SalesTemplateChannel,
      stage: t.stage,
      subject: t.subject,
      body: t.body,
      position: t.position,
      isActive: t.isActive,
    };
  }

  async templates(onlyActive: boolean): Promise<SalesTemplateDto[]> {
    const rows = await this.admin.salesTemplate.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map((t) => this.templateDto(t));
  }

  async saveTemplate(
    id: string | null,
    input: UpsertSalesTemplateInput,
    byId: string,
  ): Promise<SalesTemplateDto> {
    const data = {
      name: input.name,
      channel: input.channel,
      stage: clean(input.stage),
      subject: input.channel === 'email' ? clean(input.subject) : null,
      body: input.body,
      position: input.position,
      isActive: input.isActive,
    };
    const row = id
      ? await this.admin.salesTemplate.update({ where: { id }, data }).catch(() => {
          throw new NotFoundException({
            code: 'template_not_found',
            message: 'Plantilla no encontrada',
          });
        })
      : await this.admin.salesTemplate.create({ data });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.template_saved',
      targetType: 'platform',
      targetId: null,
      changes: { name: input.name, channel: input.channel },
    });
    return this.templateDto(row);
  }

  async deleteTemplate(id: string, byId: string): Promise<void> {
    const { count } = await this.admin.salesTemplate.deleteMany({ where: { id } });
    if (count === 0)
      throw new NotFoundException({
        code: 'template_not_found',
        message: 'Plantilla no encontrada',
      });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.template_deleted',
      targetType: 'platform',
      targetId: null,
      changes: { templateId: id },
    });
  }

  // -------------------------------------------------------------- cadencias

  private cadenceDto(c: SalesCadence): SalesCadenceDto {
    const parsed = SalesCadenceStepSchema.array().safeParse(c.steps);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      steps: parsed.success ? parsed.data : [],
      isActive: c.isActive,
    };
  }

  async cadences(onlyActive: boolean): Promise<SalesCadenceDto[]> {
    const rows = await this.admin.salesCadence.findMany({
      where: onlyActive ? { isActive: true } : {},
      orderBy: { name: 'asc' },
    });
    return rows.map((c) => this.cadenceDto(c));
  }

  async saveCadence(
    id: string | null,
    input: UpsertSalesCadenceInput,
    byId: string,
  ): Promise<SalesCadenceDto> {
    const steps = [...input.steps].sort((a, b) => a.day - b.day);
    const data = {
      name: input.name,
      description: clean(input.description),
      steps: steps as unknown as Prisma.InputJsonValue,
      isActive: input.isActive,
    };
    const row = id
      ? await this.admin.salesCadence.update({ where: { id }, data }).catch(() => {
          throw new NotFoundException({
            code: 'cadence_not_found',
            message: 'Cadencia no encontrada',
          });
        })
      : await this.admin.salesCadence.create({ data });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.cadence_saved',
      targetType: 'platform',
      targetId: null,
      changes: { name: input.name, steps: steps.length },
    });
    return this.cadenceDto(row);
  }

  async deleteCadence(id: string, byId: string): Promise<void> {
    const used = await this.admin.salesCadenceEnrollment.count({ where: { cadenceId: id } });
    if (used > 0) {
      // Con cuentas que la han usado: se desactiva para conservar su historial.
      await this.admin.salesCadence.updateMany({ where: { id }, data: { isActive: false } });
    } else {
      const { count } = await this.admin.salesCadence.deleteMany({ where: { id } });
      if (count === 0) {
        throw new NotFoundException({
          code: 'cadence_not_found',
          message: 'Cadencia no encontrada',
        });
      }
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.cadence_deleted',
      targetType: 'platform',
      targetId: null,
      changes: { cadenceId: id },
    });
  }
}
