import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { JOB_REPORTS_GENERATE, QUEUE_REPORTS } from '../queues/queues.module';

import { AgingGenerator } from './generators/aging.generator';
import { ContractsActiveGenerator } from './generators/contracts-active.generator';
import { InvoicesPeriodGenerator } from './generators/invoices-period.generator';
import { PdfRenderer } from './renderers/pdf-renderer';
import { XlsxRenderer } from './renderers/xlsx-renderer';

import type { ReportGenerator } from './generators/types';
import type { Env } from '../../config/env.schema';
import type { Prisma, ReportRun } from '@storageos/database';
import type { ReportGeneratorCatalogEntry, ReportRunDto, RunReportInput } from '@storageos/shared';

export interface ReportJobData {
  tenantId: string;
  runId: string;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly generators = new Map<string, ReportGenerator>();
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly pdfRenderer: PdfRenderer,
    private readonly xlsxRenderer: XlsxRenderer,
    private readonly invoicesGenerator: InvoicesPeriodGenerator,
    private readonly contractsGenerator: ContractsActiveGenerator,
    private readonly agingGenerator: AgingGenerator,
    @InjectQueue(QUEUE_REPORTS) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.register(this.invoicesGenerator);
    this.register(this.contractsGenerator);
    this.register(this.agingGenerator);

    const endpoint = `${config.get('MINIO_USE_SSL', { infer: true }) ? 'https' : 'http'}://${config.get('MINIO_ENDPOINT', { infer: true })}:${config.get('MINIO_PORT', { infer: true })}`;
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: config.get('MINIO_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('MINIO_SECRET_KEY', { infer: true }),
      },
      forcePathStyle: true,
    });
    this.bucket = config.get('MINIO_BUCKET_REPORTS', { infer: true });
    this.publicUrl = config.get('MINIO_PUBLIC_URL', { infer: true });
  }

  private register(g: ReportGenerator): void {
    this.generators.set(g.code, g);
  }

  catalog(): ReportGeneratorCatalogEntry[] {
    return Array.from(this.generators.values()).map((g) => ({
      code: g.code,
      name: g.name,
      description: g.description,
      formats: g.formats,
      paramsSchema: g.paramsSchema as Record<
        string,
        ReportGeneratorCatalogEntry['paramsSchema'][string]
      >,
    }));
  }

  async run(args: {
    tenantId: string;
    userId: string;
    input: RunReportInput;
  }): Promise<ReportRunDto> {
    const generator = this.generators.get(args.input.generator);
    if (!generator) {
      throw new NotFoundException({
        code: 'report_generator_not_found',
        message: 'Generador desconocido',
      });
    }
    if (!generator.formats.includes(args.input.format)) {
      throw new NotFoundException({
        code: 'report_format_unsupported',
        message: `Formato ${args.input.format} no soportado por ${generator.code}`,
      });
    }
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.create({
          data: {
            tenantId: args.tenantId,
            triggeredByUserId: args.userId,
            generatorCode: generator.code,
            format: args.input.format,
            status: 'pending',
            params: args.input.params as Prisma.InputJsonValue,
          },
        }),
      args.tenantId,
    );
    await this.queue.add(JOB_REPORTS_GENERATE, {
      tenantId: args.tenantId,
      runId: created.id,
    } satisfies ReportJobData);
    return this.toDto(created);
  }

  async list(tenantId: string, limit = 50): Promise<ReportRunDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.findMany({
          include: { triggeredBy: { select: { fullName: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto({ ...r, triggeredByName: r.triggeredBy?.fullName ?? null }));
  }

  async detail(tenantId: string, id: string): Promise<ReportRunDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.findFirst({
          where: { id },
          include: { triggeredBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'report_run_not_found',
        message: 'Informe no encontrado',
      });
    }
    return this.toDto({ ...row, triggeredByName: row.triggeredBy?.fullName ?? null });
  }

  /** Llamado por el worker (BullMQ). */
  async generate(jobData: ReportJobData): Promise<void> {
    const run = await this.admin.reportRun.findFirst({
      where: { id: jobData.runId, tenantId: jobData.tenantId },
    });
    if (!run) {
      this.logger.warn(`generate: run ${jobData.runId} no existe`);
      return;
    }
    if (run.status !== 'pending') {
      this.logger.warn(`generate: run ${jobData.runId} status=${run.status}, skip`);
      return;
    }
    await this.admin.reportRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: new Date() },
    });
    try {
      const generator = this.generators.get(run.generatorCode);
      if (!generator) throw new Error(`Generator ${run.generatorCode} no registrado`);
      const result = await generator.run({
        tenantId: run.tenantId,
        params: run.params as Record<string, unknown>,
      });
      const buffer =
        run.format === 'xlsx'
          ? await this.xlsxRenderer.render(result)
          : await this.pdfRenderer.render(result);
      const ext = run.format === 'xlsx' ? 'xlsx' : 'pdf';
      const key = `${run.tenantId}/${run.generatorCode}/${run.id}.${ext}`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType:
            run.format === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'application/pdf',
        }),
      );
      const publicUrl = `${this.publicUrl}/${this.bucket}/${key}`;
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días
      await this.admin.reportRun.update({
        where: { id: run.id },
        data: {
          status: 'done',
          finishedAt: new Date(),
          downloadUrl: publicUrl,
          fileBytes: buffer.length,
          expiresAt,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Run ${run.id} fallo: ${msg}`);
      await this.admin.reportRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), errorMessage: msg.slice(0, 1000) },
      });
      throw err;
    }
  }

  private toDto(r: ReportRun & { triggeredByName?: string | null }): ReportRunDto {
    return {
      id: r.id,
      generatorCode: r.generatorCode,
      format: r.format,
      status: r.status,
      params: (r.params ?? {}) as Record<string, unknown>,
      downloadUrl: r.downloadUrl,
      fileBytes: r.fileBytes,
      errorMessage: r.errorMessage,
      triggeredByUserId: r.triggeredByUserId,
      triggeredByName: r.triggeredByName ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
