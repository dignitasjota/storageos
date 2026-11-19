import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { isFacilityAllowed } from '../../common/facility-scope';
import { userCan } from '../../common/guards/permissions.guard';
import { tenantTimezone } from '../analytics/business-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { JOB_REPORTS_GENERATE, QUEUE_REPORTS } from '../queues/queues.module';

import { dayLabel } from './generators/report-helpers';
import { PdfRenderer } from './renderers/pdf-renderer';
import { XlsxRenderer } from './renderers/xlsx-renderer';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { AnalyticsScope } from '../analytics/analytics-scope';
import type { ReportBrand, ReportGenerator } from './generators/types';
import type { Env } from '../../config/env.schema';
import type { Prisma, ReportRun } from '@storageos/database';
import type {
  ReportGeneratorCatalogEntry,
  ReportPreviewDto,
  ReportRunDto,
  RunReportInput,
} from '@storageos/shared';

/** Lista de todos los informes (la monta el módulo). */
export const REPORT_GENERATORS = Symbol('REPORT_GENERATORS');

export interface ReportJobData {
  tenantId: string;
  runId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Un informe que lleva más de esto sin terminar se da por fallido. */
const STALE_RUN_MINUTES = 15;
const FACILITY_PARAM = 'facilityId';
/** Filas que enseña la vista previa. */
const PREVIEW_ROWS = 25;
const GENERIC_ERROR =
  'No se ha podido generar el informe. Vuelve a intentarlo; si sigue fallando, escribe a soporte.';

export type Viewer = Pick<
  AuthenticatedUser,
  'sub' | 'tenantId' | 'role' | 'permissions' | 'facilityScope'
>;

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
    @Inject(REPORT_GENERATORS) generators: ReportGenerator[],
    @InjectQueue(QUEUE_REPORTS) private readonly queue: Queue,
    private readonly files: FilesService,
    config: ConfigService<Env, true>,
  ) {
    for (const g of generators) this.register(g);

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

  generatorOf(code: string): ReportGenerator | undefined {
    return this.generators.get(code);
  }

  /** ¿Puede esta persona pedir y ver este informe? */
  allowed(g: ReportGenerator, user: Viewer): boolean {
    if (g.companyWide && user.facilityScope) return false;
    return (g.requires ?? []).every((p) => userCan(user as AuthenticatedUser, p));
  }

  async catalog(user: Viewer): Promise<ReportGeneratorCatalogEntry[]> {
    const entries: ReportGeneratorCatalogEntry[] = [];
    const facilities = await this.facilityOptions(user);
    for (const g of this.generators.values()) {
      if (!this.allowed(g, user)) continue;
      const schema = { ...g.paramsSchema } as Record<
        string,
        ReportGeneratorCatalogEntry['paramsSchema'][string]
      >;
      if (g.loadOptions) {
        const options = await g.loadOptions(user.tenantId);
        if (!options) continue;
        for (const [key, list] of Object.entries(options)) {
          if (schema[key]) schema[key] = { ...schema[key], options: list };
        }
      }
      // Con más de un local a la vista se puede pedir de uno solo.
      if (g.byFacility && facilities.length > 1) {
        schema[FACILITY_PARAM] = {
          label: 'Local (vacío = todos los que ves)',
          type: 'select',
          required: false,
          options: facilities,
        };
      }
      entries.push({
        code: g.code,
        name: g.name,
        description: g.description,
        formats: g.formats,
        paramsSchema: schema,
      });
    }
    return entries;
  }

  private async facilityOptions(user: Viewer): Promise<{ value: string; label: string }[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findMany({
          where: {
            deletedAt: null,
            ...(user.facilityScope ? { id: { in: user.facilityScope } } : {}),
          },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      user.tenantId,
    );
    return rows.map((f) => ({ value: f.id, label: f.name }));
  }

  /**
   * Comprueba que esta persona puede pedir el informe, en ese formato y con
   * esos parámetros; devuelve el informe y solo los parámetros que conoce.
   */
  async prepare(
    user: Viewer,
    input: { generator: string; format?: string; params: Record<string, unknown> },
  ): Promise<{ generator: ReportGenerator; params: Record<string, unknown> }> {
    const args = { input };
    const generator = this.generators.get(args.input.generator);
    if (!generator) {
      throw new NotFoundException({
        code: 'report_generator_not_found',
        message: 'Ese informe no existe',
      });
    }
    if (!this.allowed(generator, user)) {
      throw new ForbiddenException({
        code: 'report_not_allowed',
        message: 'No tienes permiso para pedir este informe',
      });
    }
    if (args.input.format && !generator.formats.includes(args.input.format as never)) {
      throw new BadRequestException({
        code: 'report_format_unsupported',
        message: 'Este informe no se puede generar en ese formato',
      });
    }
    // Solo se guardan los parámetros que el informe conoce.
    const params: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(generator.paramsSchema)) {
      const value = args.input.params[key];
      const empty = value === undefined || value === null || value === '';
      if (empty) {
        if (def.required) {
          throw new BadRequestException({
            code: 'report_param_required',
            message: `Falta «${def.label}»`,
          });
        }
        continue;
      }
      params[key] = value;
    }
    generator.validate?.(params);

    const facilityId = args.input.params[FACILITY_PARAM];
    if (
      generator.byFacility &&
      facilityId !== undefined &&
      facilityId !== null &&
      facilityId !== ''
    ) {
      if (typeof facilityId !== 'string' || !UUID_RE.test(facilityId)) {
        throw new BadRequestException({
          code: 'invalid_facility_id',
          message: 'El local indicado no es válido',
        });
      }
      const exists = isFacilityAllowed(user.facilityScope, facilityId)
        ? await this.prisma.withTenant(
            (tx) =>
              tx.facility.findFirst({
                where: { id: facilityId, deletedAt: null },
                select: { id: true },
              }),
            user.tenantId,
          )
        : null;
      if (!exists) {
        throw new NotFoundException({ code: 'facility_not_found', message: 'Ese local no existe' });
      }
      params[FACILITY_PARAM] = facilityId;
    }
    return { generator, params };
  }

  async run(args: { user: Viewer; input: RunReportInput }): Promise<ReportRunDto> {
    const { user } = args;
    const { generator, params } = await this.prepare(user, args.input);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.create({
          data: {
            tenantId: user.tenantId,
            triggeredByUserId: user.sub,
            generatorCode: generator.code,
            format: args.input.format,
            status: 'pending',
            params: params as Prisma.InputJsonValue,
            facilityScoped: !!user.facilityScope,
            facilityScope: user.facilityScope ?? [],
          },
          include: { triggeredBy: { select: { fullName: true } } },
        }),
      user.tenantId,
    );
    await this.queue.add(
      JOB_REPORTS_GENERATE,
      { tenantId: user.tenantId, runId: created.id } satisfies ReportJobData,
      // Un fallo se enseña al momento: repetirlo lo decide quien lo pidió.
      { attempts: 1 },
    );
    return (await this.toDtos(user.tenantId, [created]))[0]!;
  }

  /** Las primeras filas y los totales, para ver el informe antes de pedirlo. */
  async preview(
    user: Viewer,
    input: { generator: string; params: Record<string, unknown> },
  ): Promise<ReportPreviewDto> {
    const { generator, params } = await this.prepare(user, input);
    const facilityId = params[FACILITY_PARAM];
    const scope: AnalyticsScope =
      typeof facilityId === 'string'
        ? { ids: [facilityId], explicit: true }
        : { ids: user.facilityScope ?? undefined, explicit: false };
    const timezone = await this.prisma.withTenant(
      (tx) => tenantTimezone(tx, user.tenantId),
      user.tenantId,
    );
    const result = await generator.run({ tenantId: user.tenantId, params, scope, timezone });
    return {
      title: result.title,
      subtitle: result.subtitle ?? null,
      columns: result.columns.map((c) => ({
        key: c.key,
        label: c.label,
        type: c.type ?? 'text',
        align: c.align ?? (c.type === 'currency' || c.type === 'number' ? 'right' : 'left'),
      })),
      rows: result.rows.slice(0, PREVIEW_ROWS),
      totalRows: result.rows.length,
      summary: result.summary ?? [],
    };
  }

  /**
   * Informes que esta persona puede ver: los de un tipo para el que tiene
   * permiso y, si solo ve algunos locales, únicamente los que pidió ella (los
   * de los demás pueden llevar otros locales).
   */
  private visibleWhere(user: Viewer): Prisma.ReportRunWhereInput {
    const codes = [...this.generators.values()]
      .filter((g) => (g.requires ?? []).every((p) => userCan(user as AuthenticatedUser, p)))
      .map((g) => g.code);
    return {
      generatorCode: { in: codes },
      ...(user.facilityScope ? { triggeredByUserId: user.sub } : {}),
    };
  }

  async list(user: Viewer, limit = 50): Promise<ReportRunDto[]> {
    await this.failStale(user.tenantId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.findMany({
          where: this.visibleWhere(user),
          include: { triggeredBy: { select: { fullName: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      user.tenantId,
    );
    return this.toDtos(user.tenantId, rows);
  }

  /** Los que se quedaron a medias (reinicio del servidor) dejan de «generarse». */
  private async failStale(tenantId: string): Promise<void> {
    const limit = new Date(Date.now() - STALE_RUN_MINUTES * 60_000);
    await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.updateMany({
          where: { status: { in: ['pending', 'running'] }, createdAt: { lt: limit } },
          data: { status: 'failed', finishedAt: new Date(), errorMessage: GENERIC_ERROR },
        }),
      tenantId,
    );
  }

  private async findVisible(user: Viewer, id: string) {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.reportRun.findFirst({
          where: { id, ...this.visibleWhere(user) },
          include: { triggeredBy: { select: { fullName: true } } },
        }),
      user.tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'report_run_not_found',
        message: 'Informe no encontrado',
      });
    }
    return row;
  }

  async detail(user: Viewer, id: string): Promise<ReportRunDto> {
    const row = await this.findVisible(user, id);
    return (await this.toDtos(user.tenantId, [row]))[0]!;
  }

  /** Quita un informe de la lista y borra su fichero. */
  async remove(user: Viewer, id: string): Promise<void> {
    const row = await this.findVisible(user, id);
    if (row.downloadUrl) {
      const key = this.files.keyFromPublicUrl('reports', row.downloadUrl);
      if (key) await this.files.deleteObjects('reports', [key]).catch(() => undefined);
    }
    await this.prisma.withTenant(
      (tx) => tx.reportRun.deleteMany({ where: { id: row.id } }),
      user.tenantId,
    );
  }

  /**
   * URL firmada de corta duración para descargar el informe generado. El
   * `download_url` guardado es una URL PERMANENTE sin firmar sobre un
   * bucket privado (`reports`) — nunca se expone tal cual; se firma bajo
   * demanda.
   */
  async getSignedDownloadUrl(user: Viewer, id: string): Promise<{ url: string }> {
    const row = await this.findVisible(user, id);
    const generator = this.generators.get(row.generatorCode);
    const ext = row.format === 'xlsx' ? 'xlsx' : 'pdf';
    const key =
      row.downloadUrl && row.status === 'done'
        ? this.files.keyFromPublicUrl('reports', row.downloadUrl)
        : null;
    // Con nombre propio y como descarga (no depende de abrir otra pestaña).
    const filename = `${fileSlug(generator?.name ?? 'informe')}-${row.createdAt.toISOString().slice(0, 10)}.${ext}`;
    const url = key ? await this.files.getPresignedGetUrl('reports', key, 300, filename) : null;
    if (!url) {
      throw new NotFoundException({
        code: 'download_not_available',
        message: 'Aún no hay un fichero disponible para descargar',
      });
    }
    return { url };
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
    // `running` = el proceso se cortó a medias y la cola lo repite.
    if (run.status !== 'pending' && run.status !== 'running') {
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
      const params = run.params as Record<string, unknown>;
      const facilityId = params[FACILITY_PARAM];
      const scope: AnalyticsScope =
        typeof facilityId === 'string'
          ? { ids: [facilityId], explicit: true }
          : { ids: run.facilityScoped ? run.facilityScope : undefined, explicit: false };
      const timezone = await this.prisma.withTenant(
        (tx) => tenantTimezone(tx, run.tenantId),
        run.tenantId,
      );
      const result = await generator.run({ tenantId: run.tenantId, params, scope, timezone });
      result.brand = await this.brandOf(run.tenantId);
      if (typeof facilityId === 'string') {
        const facility = await this.admin.facility.findFirst({
          where: { id: facilityId, tenantId: run.tenantId },
          select: { name: true },
        });
        if (facility) {
          result.subtitle = [result.subtitle, facility.name].filter(Boolean).join(' · ');
        }
      } else if (run.facilityScoped) {
        result.subtitle = [result.subtitle, 'Solo tus locales'].filter(Boolean).join(' · ');
      }
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
      // Un error de datos (4xx) se explica; uno técnico no se enseña tal cual.
      const expected = err instanceof HttpException && err.getStatus() < 500;
      await this.admin.reportRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage: expected ? msg.slice(0, 300) : GENERIC_ERROR,
        },
      });
      if (!expected) throw err;
    }
  }

  /**
   * Nombre, color y logo del negocio para la cabecera del informe. El logo solo
   * si está subido (se lee del almacén y va dentro del fichero; nunca se
   * descarga una dirección ajena).
   */
  private async brandOf(tenantId: string): Promise<ReportBrand> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, portalBrandColor: true, portalLogoKey: true },
    });
    const color =
      t?.portalBrandColor && /^#[0-9a-f]{6}$/i.test(t.portalBrandColor) ? t.portalBrandColor : null;
    let logoDataUri: string | null = null;
    if (t?.portalLogoKey && t.portalLogoKey.startsWith(`${tenantId}/`)) {
      try {
        const bytes = await this.files.getObject({ bucket: 'public', key: t.portalLogoKey });
        const mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
        if (bytes.length <= 2_000_000) {
          logoDataUri = `data:${mime};base64,${bytes.toString('base64')}`;
        }
      } catch {
        logoDataUri = null;
      }
    }
    return { name: t?.name ?? null, color, logoDataUri };
  }

  /** Nombres de locales y propietarios para describir cada informe de la lista. */
  private async toDtos(
    tenantId: string,
    rows: (ReportRun & { triggeredBy?: { fullName: string } | null })[],
  ): Promise<ReportRunDto[]> {
    const ids = (key: string) => [
      ...new Set(
        rows
          .map((r) => (r.params as Record<string, unknown> | null)?.[key])
          .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)),
      ),
    ];
    const facilityIds = ids(FACILITY_PARAM);
    const ownerIds = ids('ownerId');
    const names = new Map<string, string>();
    if (facilityIds.length > 0 || ownerIds.length > 0) {
      await this.prisma.withTenant(async (tx) => {
        const [facilities, owners] = await Promise.all([
          facilityIds.length
            ? tx.facility.findMany({
                where: { id: { in: facilityIds } },
                select: { id: true, name: true },
              })
            : [],
          ownerIds.length
            ? tx.owner.findMany({
                where: { id: { in: ownerIds } },
                select: { id: true, legalName: true },
              })
            : [],
        ]);
        for (const f of facilities) names.set(f.id, f.name);
        for (const o of owners) names.set(o.id, o.legalName);
      }, tenantId);
    }
    return rows.map((r) =>
      this.toDto({ ...r, triggeredByName: r.triggeredBy?.fullName ?? null }, names),
    );
  }

  private paramsLabel(r: ReportRun, names: Map<string, string>): string | null {
    const p = (r.params ?? {}) as Record<string, unknown>;
    const str = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : null);
    const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const parts: string[] = [];
    const from = str('from');
    const to = str('to');
    const month = str('month');
    const atDate = str('atDate');
    if (isDay(from) && isDay(to)) parts.push(`${dayLabel(from)} – ${dayLabel(to)}`);
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      parts.push(
        new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString('es-ES', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }),
      );
    }
    if (isDay(atDate)) parts.push(`A ${dayLabel(atDate)}`);
    const owner = str('ownerId');
    if (owner && names.has(owner)) parts.push(names.get(owner)!);
    const facility = str(FACILITY_PARAM);
    if (facility && names.has(facility)) parts.push(names.get(facility)!);
    else if (r.facilityScoped) parts.push('Solo sus locales');
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  private toDto(
    r: ReportRun & { triggeredByName?: string | null },
    names: Map<string, string>,
  ): ReportRunDto {
    return {
      id: r.id,
      generatorCode: r.generatorCode,
      generatorName: this.generators.get(r.generatorCode)?.name ?? 'Informe',
      paramsLabel: this.paramsLabel(r, names),
      format: r.format,
      status: r.status,
      params: (r.params ?? {}) as Record<string, unknown>,
      hasDownload: !!r.downloadUrl && r.status === 'done',
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

/** «Facturas emitidas en un periodo» → `facturas-emitidas-en-un-periodo`. */
function fileSlug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'informe'
  );
}
