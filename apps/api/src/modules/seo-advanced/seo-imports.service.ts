import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GscImportError,
  SEO_IMPORT_DIMENSIONS,
  SEO_IMPORT_MAX_BYTES,
  aggregateSearchMetrics,
  parseGscExport,
  type ParsedGscExport,
  type SeoImportDetailDto,
  type SeoImportDimension,
  type SeoImportDto,
  type SeoImportFilter,
  type SeoImportFormat,
  type SeoImportLanguage,
  type SeoImportPreviewDto,
  type SeoImportRowInput,
} from '@storageos/shared';

import { isUniqueViolation } from '../../common/prisma-errors';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { readGscExport } from './gsc-import.reader';
import { SeoProjectsService, type SeoActor, type SeoOwner } from './seo-projects.service';

import type { Prisma } from '@storageos/database';

/** El fichero subido (multer en memoria). */
export interface SeoUploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

const CHUNK = 5000;
/** Filas que se enseñan como mucho de cada pestaña (Google exporta 1.000). */
const DETAIL_ROWS = 5000;
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

type ImportRow = Prisma.SeoGscImportGetPayload<{
  include: { domain: { select: { domain: true } } };
}>;

/** Qué días de «Fechas» entran en el cruce `site` y cuáles ya estaban. */
export interface SiteDaysPlan {
  toAdd: SeoImportRowInput[];
  siteDaysApi: number;
  siteDaysImported: number;
}

interface Analysis extends SiteDaysPlan {
  domain: { id: string; domain: string };
  fileName: string;
  fileHash: string;
  fileSize: number;
  format: SeoImportFormat;
  parsed: ParsedGscExport;
}

/**
 * Importación de los Excel históricos de Search Console (§18.1 y §19.7): la
 * pestaña Fechas rellena el cruce `site` solo en los días que no tiene la API;
 * el resto de pestañas se guardan como foto del periodo, aparte.
 */
@Injectable()
export class SeoImportsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  /** Lo que haría la importación, sin guardar nada. */
  async preview(
    owner: SeoOwner,
    projectId: string,
    domainId: string,
    file: SeoUploadedFile | undefined,
  ): Promise<SeoImportPreviewDto> {
    const a = await this.analyze(owner, projectId, domainId, file);
    return {
      domainId: a.domain.id,
      domain: a.domain.domain,
      fileName: a.fileName,
      fileHash: a.fileHash,
      format: a.format,
      language: a.parsed.language,
      periodFrom: a.parsed.periodFrom,
      periodTo: a.parsed.periodTo,
      filters: a.parsed.filters,
      filtered: a.parsed.filtered,
      filterReasons: a.parsed.filterReasons,
      warnings: a.parsed.warnings,
      tabRows: tabRows(a.parsed),
      siteDaysApi: a.siteDaysApi,
      siteDaysImported: a.siteDaysImported,
      siteDaysToAdd: a.toAdd.length,
    };
  }

  /** Importa el fichero (el mismo que se previsualizó). */
  async create(
    owner: SeoOwner,
    projectId: string,
    domainId: string,
    file: SeoUploadedFile | undefined,
    actor: SeoActor,
  ): Promise<SeoImportDto> {
    const a = await this.analyze(owner, projectId, domainId, file);
    let importId: string;
    try {
      importId = await this.admin.$transaction(
        (tx) =>
          this.writeImport(tx, {
            owner,
            projectId,
            domainId: a.domain.id,
            fileName: a.fileName,
            fileHash: a.fileHash,
            fileSize: a.fileSize,
            format: a.format,
            parsed: a.parsed,
            days: a,
            actor,
            masterImportId: null,
          }),
        { timeout: 120_000 },
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicate(null);
      throw err;
    }
    return this.get(owner, projectId, importId);
  }

  /**
   * Guarda una importación ya analizada (dentro de la transacción de quien
   * llama): sus pestañas y los días de «Fechas» que no tiene nadie. La usan
   * la importación de Search Console y la de los maestros (sus pestañas GSC_*).
   */
  async writeImport(
    tx: Prisma.TransactionClient,
    args: {
      owner: SeoOwner;
      projectId: string;
      domainId: string;
      fileName: string;
      fileHash: string;
      fileSize: number;
      format: SeoImportFormat;
      parsed: ParsedGscExport;
      days: SiteDaysPlan;
      actor: SeoActor;
      masterImportId: string | null;
    },
  ): Promise<string> {
    const { parsed, days } = args;
    const created = await tx.seoGscImport.create({
      data: {
        tenantId: args.owner,
        projectId: args.projectId,
        domainId: args.domainId,
        fileName: args.fileName,
        fileHash: args.fileHash,
        fileSize: args.fileSize,
        format: args.format,
        language: parsed.language,
        periodFrom: day(parsed.periodFrom),
        periodTo: day(parsed.periodTo),
        filters: parsed.filters as unknown as Prisma.InputJsonValue,
        filtered: parsed.filtered,
        tabRows: tabRows(parsed) as Prisma.InputJsonValue,
        siteDaysApi: days.siteDaysApi,
        siteDaysImported: days.siteDaysImported,
        createdByUserId: args.actor.userId ?? null,
        createdBySuperAdminId: args.actor.superAdminId ?? null,
        masterImportId: args.masterImportId,
      },
      select: { id: true },
    });
    const rows = parsed.tabs.flatMap((t) =>
      t.rows.map((r) => ({
        tenantId: args.owner,
        importId: created.id,
        dimension: t.dimension,
        value: r.value,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position === null ? null : Math.min(99999, r.position),
      })),
    );
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.seoGscImportRow.createMany({ data: rows.slice(i, i + CHUNK) });
    }
    // Solo los días que no tiene nadie: si a la vez entra la API, el
    // índice único deja fuera el día repetido (y manda la API).
    const inserted = await tx.seoGscMetric.createMany({
      data: days.toAdd.map((r) => ({
        tenantId: args.owner,
        domainId: args.domainId,
        grain: 'site',
        date: day(r.value),
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr ?? (r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 1e6) / 1e6 : 0),
        position: Math.min(99999, r.position ?? 0),
        source: 'import',
        importId: created.id,
      })),
      skipDuplicates: true,
    });
    await tx.seoGscImport.update({
      where: { id: created.id },
      data: { siteDaysAdded: inserted.count },
    });
    return created.id;
  }

  /**
   * Qué días de la pestaña Fechas entran en el cruce del sitio: los que no
   * tiene ni la API ni otra importación (y ninguno si el fichero lleva filtros).
   */
  async planSiteDays(domainId: string, parsed: ParsedGscExport): Promise<SiteDaysPlan> {
    const dates = parsed.tabs.find((t) => t.dimension === 'date')?.rows ?? [];
    const stored = await this.admin.seoGscMetric.findMany({
      where: {
        domainId,
        grain: 'site',
        date: { gte: day(parsed.periodFrom), lte: day(parsed.periodTo) },
      },
      select: { date: true, source: true },
    });
    const bySource = new Map(stored.map((r) => [dateOnly(r.date), r.source]));
    let siteDaysApi = 0;
    let siteDaysImported = 0;
    const toAdd: SeoImportRowInput[] = [];
    for (const d of dates) {
      const source = bySource.get(d.value);
      if (source === 'api') siteDaysApi++;
      else if (source) siteDaysImported++;
      else if (!parsed.filtered) toAdd.push(d);
    }
    return { toAdd, siteDaysApi, siteDaysImported };
  }

  async list(owner: SeoOwner | undefined, projectId: string): Promise<SeoImportDto[]> {
    await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoGscImport.findMany({
      where: { projectId },
      include: { domain: { select: { domain: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.toDtos(rows);
  }

  /** Una importación con sus pestañas (los totales, recalculados). */
  async detail(
    owner: SeoOwner | undefined,
    projectId: string,
    importId: string,
  ): Promise<SeoImportDetailDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findImport(projectId, importId);
    const [dto] = await this.toDtos([row]);
    const tabs = await Promise.all(
      SEO_IMPORT_DIMENSIONS.filter((d) => (dto!.tabRows[d] ?? 0) > 0).map(async (dimension) => {
        const rows = await this.admin.seoGscImportRow.findMany({
          where: { importId, dimension },
          orderBy:
            dimension === 'date'
              ? [{ value: 'asc' }]
              : [{ clicks: 'desc' }, { impressions: 'desc' }, { value: 'asc' }],
          take: DETAIL_ROWS,
        });
        const plain = rows.map((r) => ({
          value: r.value,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 1000) / 1000 : null,
          position: r.position === null ? null : Number(r.position),
        }));
        return {
          dimension,
          totals: aggregateSearchMetrics(
            plain
              .filter((r) => r.position !== null || r.impressions === 0)
              .map((r) => ({ ...r, position: r.position ?? 0 })),
          ),
          rows: plain,
        };
      }),
    );
    return { ...dto!, tabs };
  }

  /** Borra la importación: sus filas y los días que añadió al cruce del sitio. */
  async remove(owner: SeoOwner, projectId: string, importId: string): Promise<void> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findImport(projectId, importId);
    if (row.masterImportId) {
      throw new ConflictException({
        code: 'seo_import_from_master',
        message:
          'Estas pestañas vienen de un maestro: se borran al borrar la importación del maestro.',
      });
    }
    await this.admin.seoGscImport.delete({ where: { id: importId } });
  }

  async get(owner: SeoOwner | undefined, projectId: string, importId: string) {
    await this.projects.resolveProject(owner, projectId);
    const [dto] = await this.toDtos([await this.findImport(projectId, importId)]);
    return dto!;
  }

  // ------------------------------------------------------------- auxiliares

  private async analyze(
    owner: SeoOwner,
    projectId: string,
    domainId: string,
    file: SeoUploadedFile | undefined,
  ): Promise<Analysis> {
    const project = await this.projects.resolveProject(owner, projectId);
    const domain = project.domains.find((d) => d.id === domainId);
    if (!domain) {
      throw new NotFoundException({ code: 'seo_not_found', message: 'Ese dominio no existe.' });
    }
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        code: 'seo_import_file_required',
        message: 'Sube el Excel (.xlsx) o el .zip de CSV que exporta Search Console.',
      });
    }
    if (file.buffer.length > SEO_IMPORT_MAX_BYTES) {
      throw new BadRequestException({
        code: 'seo_import_too_large',
        message: 'El fichero pasa de 20 MB.',
      });
    }
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.admin.seoGscImport.findFirst({
      where: { projectId, fileHash },
      select: { createdAt: true },
    });
    if (existing) throw this.duplicate(existing.createdAt);
    let format: SeoImportFormat;
    let parsed: ParsedGscExport;
    try {
      const read = await readGscExport(file.buffer);
      format = read.format;
      parsed = parseGscExport(read.sheets);
    } catch (err) {
      if (err instanceof GscImportError) {
        throw new BadRequestException({ code: 'seo_import_invalid', message: err.message });
      }
      throw err;
    }
    const days = await this.planSiteDays(domainId, parsed);
    return {
      domain: { id: domain.id, domain: domain.domain },
      fileName: (file.originalname || 'search-console').slice(0, 200),
      fileHash,
      fileSize: file.buffer.length,
      format,
      parsed,
      ...days,
    };
  }

  private async findImport(projectId: string, importId: string): Promise<ImportRow> {
    const row = await this.admin.seoGscImport.findFirst({
      where: { id: importId, projectId },
      include: { domain: { select: { domain: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
    return row;
  }

  private duplicate(when: Date | null): ConflictException {
    const date = when
      ? ` el ${when.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })}`
      : '';
    return new ConflictException({
      code: 'seo_import_duplicate',
      message: `Este fichero ya se importó${date}. Si quieres volver a cargarlo, borra antes esa importación.`,
    });
  }

  private async toDtos(rows: ImportRow[]): Promise<SeoImportDto[]> {
    const userIds = [
      ...new Set(rows.flatMap((r) => (r.createdByUserId ? [r.createdByUserId] : []))),
    ];
    const adminIds = [
      ...new Set(rows.flatMap((r) => (r.createdBySuperAdminId ? [r.createdBySuperAdminId] : []))),
    ];
    const [users, admins] = await Promise.all([
      userIds.length
        ? this.admin.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, fullName: true },
          })
        : [],
      adminIds.length
        ? this.admin.superAdmin.findMany({
            where: { id: { in: adminIds } },
            select: { id: true, fullName: true },
          })
        : [],
    ]);
    const names = new Map([...users, ...admins].map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id,
      domainId: r.domainId,
      domain: r.domain.domain,
      fileName: r.fileName,
      format: r.format as SeoImportFormat,
      language: r.language as SeoImportLanguage,
      periodFrom: dateOnly(r.periodFrom),
      periodTo: dateOnly(r.periodTo),
      filters: r.filters as unknown as SeoImportFilter[],
      filtered: r.filtered,
      tabRows: r.tabRows as Partial<Record<SeoImportDimension, number>>,
      siteDaysAdded: r.siteDaysAdded,
      siteDaysApi: r.siteDaysApi,
      siteDaysImported: r.siteDaysImported,
      createdAt: r.createdAt.toISOString(),
      createdBy:
        names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
      masterImportId: r.masterImportId,
    }));
  }
}

function tabRows(parsed: ParsedGscExport): Partial<Record<SeoImportDimension, number>> {
  return Object.fromEntries(parsed.tabs.map((t) => [t.dimension, t.rows.length]));
}
