import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { InvoiceSeries, Prisma } from '@storageos/database';
import type {
  CreateInvoiceSeriesInput,
  InvoiceSeriesDto,
  UpdateInvoiceSeriesInput,
} from '@storageos/shared';

@Injectable()
export class InvoiceSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<InvoiceSeriesDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoiceSeries.findMany({
          orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async getDefault(tenantId: string): Promise<InvoiceSeries | null> {
    return this.prisma.withTenant(
      (tx) =>
        tx.invoiceSeries.findFirst({
          where: { isDefault: true, isActive: true },
          orderBy: { code: 'asc' },
        }),
      tenantId,
    );
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateInvoiceSeriesInput;
    meta: RequestMeta;
  }): Promise<InvoiceSeriesDto> {
    const created = await this.prisma.withTenant(async (tx) => {
      // Si es default, desmarcar la anterior.
      if (args.input.isDefault) {
        await tx.invoiceSeries.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      try {
        return await tx.invoiceSeries.create({
          data: {
            tenantId: args.tenantId,
            code: args.input.code.trim().toUpperCase(),
            name: args.input.name.trim(),
            prefix: args.input.prefix.trim().toUpperCase(),
            yearScope: args.input.yearScope,
            ...(args.input.facilityId ? { facilityId: args.input.facilityId } : {}),
            isDefault: args.input.isDefault,
          },
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'invoice_series_code_taken',
            message: 'Ya existe una serie con ese codigo',
          });
        }
        throw err;
      }
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice_series.created',
      entityType: 'InvoiceSeries',
      entityId: created.id,
      changes: { code: created.code },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    seriesId: string;
    input: UpdateInvoiceSeriesInput;
    meta: RequestMeta;
  }): Promise<InvoiceSeriesDto> {
    const existing = await this.findOrThrow(args.tenantId, args.seriesId);
    const updated = await this.prisma.withTenant(async (tx) => {
      if (args.input.isDefault === true && !existing.isDefault) {
        await tx.invoiceSeries.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.invoiceSeries.update({
        where: { id: args.seriesId },
        data: {
          ...(args.input.name !== undefined ? { name: args.input.name.trim() } : {}),
          ...(args.input.prefix !== undefined
            ? { prefix: args.input.prefix.trim().toUpperCase() }
            : {}),
          ...(args.input.yearScope !== undefined ? { yearScope: args.input.yearScope } : {}),
          ...(args.input.isActive !== undefined ? { isActive: args.input.isActive } : {}),
          ...(args.input.isDefault !== undefined ? { isDefault: args.input.isDefault } : {}),
        },
      });
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice_series.updated',
      entityType: 'InvoiceSeries',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Reserva el siguiente número en la serie. Atomic: incrementa
   * `next_number` y devuelve el valor que tenía antes. Llamado desde
   * `InvoicesService.issue` dentro de su transacción.
   */
  async reserveNextNumber(
    tx: Prisma.TransactionClient,
    seriesId: string,
  ): Promise<{ sequenceNumber: number; series: InvoiceSeries }> {
    const series = await tx.invoiceSeries.findUniqueOrThrow({
      where: { id: seriesId },
    });
    if (!series.isActive) {
      throw new ConflictException({
        code: 'invoice_series_inactive',
        message: 'La serie esta desactivada',
      });
    }
    const updated = await tx.invoiceSeries.update({
      where: { id: seriesId },
      data: { nextNumber: { increment: 1 } },
    });
    return { sequenceNumber: updated.nextNumber - 1, series: updated };
  }

  /** Formato del invoice_number a partir de prefix + año + sequence. */
  formatInvoiceNumber(series: InvoiceSeries, sequence: number): string {
    const year = new Date().getFullYear();
    const seq = String(sequence).padStart(5, '0');
    if (series.yearScope) {
      return `${series.prefix}/${year}/${seq}`;
    }
    return `${series.prefix}/${seq}`;
  }

  private async findOrThrow(tenantId: string, seriesId: string): Promise<InvoiceSeries> {
    const row = await this.prisma.withTenant(
      (tx) => tx.invoiceSeries.findUnique({ where: { id: seriesId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'invoice_series_not_found',
        message: 'Serie no encontrada',
      });
    }
    return row;
  }

  private toDto(row: InvoiceSeries): InvoiceSeriesDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      prefix: row.prefix,
      yearScope: row.yearScope,
      nextNumber: row.nextNumber,
      facilityId: row.facilityId,
      isActive: row.isActive,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
