import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SEO_SISTRIX_CSV_MAX_BYTES,
  normalizeSeoDomain,
  normalizeSeoKeyword,
  stripWwwDomain,
  type SeoSistrixCsvKind,
  type SeoSistrixCsvPreviewDto,
  type SeoSistrixImportDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { type SeoActor, SeoProjectsService, type SeoOwner } from '../seo-projects.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';

import {
  type CompetitorCsvRow,
  type KeywordCsvRow,
  type ParsedCsv,
  type SerpCsvRow,
  SistrixCsvError,
  parseCompetitorsCsv,
  parseDomainKeywordsCsv,
  parseSerpCsv,
} from './sistrix-csv.parser';

export interface CsvUpload {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface CsvParams {
  kind: SeoSistrixCsvKind;
  /** Dominio de las palabras (obligatorio en «palabras de un dominio»). */
  domain?: string | undefined;
  /** Búsqueda de los resultados (obligatoria en «resultados de una búsqueda»). */
  keyword?: string | undefined;
}

const CHUNK = 1000;
const today = () => new Date().toISOString().slice(0, 10);
const day = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * Importar los CSV de SISTRIX (mejora 8): palabras de un dominio, resultados de
 * una búsqueda y competidores, con el proveedor `manual_import`. Nada gasta
 * créditos. Con vista previa, límites de tamaño, sin duplicar (mismo día y
 * misma fila) y marcados como importación manual con su fecha; cada importación
 * se puede borrar con todo lo que trajo.
 */
@Injectable()
export class SeoSistrixCsvService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  private text(file: CsvUpload | undefined): string {
    if (!file || file.size === 0) {
      throw new BadRequestException({
        code: 'seo_csv_required',
        message: 'Elige el fichero CSV de SISTRIX.',
      });
    }
    if (file.size > SEO_SISTRIX_CSV_MAX_BYTES) {
      throw new BadRequestException({
        code: 'seo_csv_too_big',
        message: 'El fichero pesa más de 5 MB.',
      });
    }
    return file.buffer.toString('utf8');
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof SistrixCsvError) {
        throw new BadRequestException({ code: 'seo_csv_invalid', message: err.message });
      }
      throw err;
    }
  }

  /** El dominio tiene que ser tuyo o de un competidor; la búsqueda, texto válido. */
  private async target(
    owner: SeoOwner | undefined,
    projectId: string,
    params: CsvParams,
  ): Promise<{
    domain: string | null;
    keyword: string | null;
    project: Awaited<ReturnType<SeoProjectsService['resolveProject']>>;
  }> {
    const project = await this.projects.resolveProject(owner, projectId);
    let domain: string | null = null;
    let keyword: string | null = null;
    if (params.kind === 'domain_keywords') {
      domain = normalizeSeoDomain(params.domain ?? '');
      if (!domain) {
        throw new BadRequestException({
          code: 'seo_csv_domain_required',
          message: 'Di de qué dominio son las palabras.',
        });
      }
      const competitors = await this.admin.seoCompetitor.findMany({
        where: { projectId },
        select: { domain: true },
      });
      const known = new Set([
        ...project.domains.map((d) => stripWwwDomain(d.domain)),
        ...competitors.map((c) => stripWwwDomain(c.domain)),
      ]);
      if (!known.has(domain)) {
        throw new BadRequestException({
          code: 'seo_domain_not_in_project',
          message: 'Ese dominio no es del proyecto ni de sus competidores.',
        });
      }
    }
    if (params.kind === 'serp') {
      keyword = normalizeSeoKeyword(params.keyword ?? '');
      if (keyword.length < 2 || keyword.length > 200) {
        throw new BadRequestException({
          code: 'seo_csv_keyword_required',
          message: 'Escribe la búsqueda de la que son los resultados.',
        });
      }
    }
    return { domain, keyword, project };
  }

  async preview(
    owner: SeoOwner | undefined,
    projectId: string,
    file: CsvUpload | undefined,
    params: CsvParams,
  ): Promise<SeoSistrixCsvPreviewDto> {
    const text = this.text(file);
    const t = await this.target(owner, projectId, params);
    const parsed: ParsedCsv<KeywordCsvRow | SerpCsvRow | CompetitorCsvRow> = this.guard(() =>
      params.kind === 'domain_keywords'
        ? parseDomainKeywordsCsv(text)
        : params.kind === 'serp'
          ? parseSerpCsv(text)
          : parseCompetitorsCsv(text),
    );
    const pool = poolOfProject(t.project);
    const country = t.project.country.toLowerCase();
    const fresh = await this.fresh(params.kind, pool, country, t, projectId, parsed.rows);
    const sample = parsed.rows.slice(0, 8).map((r) => {
      if ('keyword' in r) return { a: r.keyword, b: String(r.position), c: r.url };
      if ('position' in r) return { a: String(r.position), b: r.domain, c: r.url };
      return { a: r.domain, b: '', c: '' };
    });
    return {
      kind: params.kind,
      filename: file!.originalname,
      domain: t.domain,
      keyword: t.keyword,
      country: country.toUpperCase(),
      rows: fresh,
      skipped: parsed.skipped + (parsed.rows.length - fresh),
      sample,
      warnings: parsed.warnings,
    };
  }

  /** Cuántas filas son nuevas (las que ya están de hoy no se vuelven a guardar). */
  private async fresh(
    kind: SeoSistrixCsvKind,
    pool: string | null,
    country: string,
    t: { domain: string | null; keyword: string | null },
    projectId: string,
    rows: readonly unknown[],
  ): Promise<number> {
    if (kind === 'domain_keywords') {
      const have = await this.admin.seoDomainKeyword.findMany({
        where: {
          tenantId: pool,
          domain: t.domain!,
          country,
          provider: 'manual_import',
          sampleDate: day(today()),
        },
        select: { keyword: true },
      });
      const set = new Set(have.map((h) => h.keyword));
      return (rows as { keyword: string }[]).filter((r) => !set.has(r.keyword)).length;
    }
    if (kind === 'serp') {
      const kw = await this.admin.seoKeyword.findFirst({
        where: { keyword: t.keyword!, country, language: { not: '' } },
        select: { id: true },
      });
      if (!kw) return rows.length;
      const have = await this.admin.seoSerpResult.count({
        where: {
          tenantId: pool,
          keywordId: kw.id,
          country,
          provider: 'manual_import',
          sampleDate: day(today()),
        },
      });
      return have > 0 ? 0 : rows.length;
    }
    const have = await this.admin.seoCompetitor.findMany({
      where: { projectId },
      select: { domain: true },
    });
    const set = new Set(have.map((h) => stripWwwDomain(h.domain)));
    return (rows as { domain: string }[]).filter((r) => !set.has(r.domain)).length;
  }

  async commit(
    owner: SeoOwner,
    projectId: string,
    file: CsvUpload | undefined,
    params: CsvParams,
    actor: SeoActor,
  ): Promise<SeoSistrixImportDto> {
    const text = this.text(file);
    const t = await this.target(owner, projectId, params);
    const pool = poolOfProject(t.project);
    const country = t.project.country.toLowerCase();
    const date = day(today());
    const kwRows =
      params.kind === 'domain_keywords' ? this.guard(() => parseDomainKeywordsCsv(text)) : null;
    const serpRows = params.kind === 'serp' ? this.guard(() => parseSerpCsv(text)) : null;
    const compRows =
      params.kind === 'competitors' ? this.guard(() => parseCompetitorsCsv(text)) : null;
    const parsed = kwRows ?? serpRows ?? compRows!;
    const fetchedAt = new Date();
    const created = await this.admin.seoSistrixImport.create({
      data: {
        tenantId: t.project.tenantId,
        projectId,
        kind: params.kind,
        filename: file!.originalname.slice(0, 200),
        domain: t.domain,
        keyword: t.keyword,
        country: country.toUpperCase(),
        createdByUserId: actor.userId ?? null,
        createdBySuperAdminId: actor.superAdminId ?? null,
      },
    });
    let inserted = 0;
    if (kwRows) {
      const have = await this.admin.seoDomainKeyword.findMany({
        where: {
          tenantId: pool,
          domain: t.domain!,
          country,
          provider: 'manual_import',
          sampleDate: date,
        },
        select: { keyword: true },
      });
      const set = new Set(have.map((h) => h.keyword));
      const rows = kwRows.rows.filter((r) => !set.has(r.keyword));
      for (let i = 0; i < rows.length; i += CHUNK) {
        const res = await this.admin.seoDomainKeyword.createMany({
          data: rows.slice(i, i + CHUNK).map((r) => ({
            tenantId: pool,
            domain: t.domain!,
            country,
            provider: 'manual_import',
            sampleDate: date,
            fetchedAt,
            keyword: r.keyword,
            position: r.position,
            url: r.url,
            sistrixImportId: created.id,
          })),
        });
        inserted += res.count;
      }
    } else if (serpRows) {
      const keyword = await this.admin.seoKeyword.upsert({
        where: {
          keyword_country_language: {
            keyword: t.keyword!,
            country,
            language: t.project.language,
          },
        },
        create: { keyword: t.keyword!, country, language: t.project.language },
        update: {},
      });
      const have = await this.admin.seoSerpResult.count({
        where: {
          tenantId: pool,
          keywordId: keyword.id,
          country,
          provider: 'manual_import',
          sampleDate: date,
        },
      });
      if (have === 0) {
        const res = await this.admin.seoSerpResult.createMany({
          data: serpRows.rows.map((r) => ({
            tenantId: pool,
            keywordId: keyword.id,
            country,
            provider: 'manual_import',
            sampleDate: date,
            fetchedAt,
            position: r.position,
            domain: r.domain,
            url: r.url,
            title: r.title,
            sistrixImportId: created.id,
          })),
        });
        inserted = res.count;
      }
    } else if (compRows) {
      const own = new Set(t.project.domains.map((d) => stripWwwDomain(d.domain)));
      const have = await this.admin.seoCompetitor.findMany({
        where: { projectId },
        select: { domain: true },
      });
      const set = new Set(have.map((h) => stripWwwDomain(h.domain)));
      const rows = compRows.rows.filter((r) => !set.has(r.domain) && !own.has(r.domain));
      // Quedan como «descubiertos» sin seguir: no ocupan sitio del límite hasta que los actives.
      const res = await this.admin.seoCompetitor.createMany({
        data: rows.map((r) => ({
          tenantId: t.project.tenantId,
          projectId,
          domain: r.domain,
          source: 'discovered',
          isActive: false,
        })),
        skipDuplicates: true,
      });
      inserted = res.count;
    }
    const row = await this.admin.seoSistrixImport.update({
      where: { id: created.id },
      data: { rows: inserted, skipped: parsed.skipped + (parsed.rows.length - inserted) },
    });
    return this.dto(row, null);
  }

  async list(owner: SeoOwner | undefined, projectId: string): Promise<SeoSistrixImportDto[]> {
    await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoSistrixImport.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.dto(r, null));
  }

  /** Borra la importación y todo lo que trajo (palabras y resultados). Los competidores se quedan. */
  async remove(owner: SeoOwner, projectId: string, id: string): Promise<void> {
    await this.projects.resolveProject(owner, projectId);
    const res = await this.admin.seoSistrixImport.deleteMany({ where: { id, projectId } });
    if (res.count === 0) {
      throw new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
    }
  }

  private dto(
    r: {
      id: string;
      kind: string;
      filename: string;
      domain: string | null;
      keyword: string | null;
      country: string;
      rows: number;
      skipped: number;
      createdAt: Date;
    },
    createdBy: string | null,
  ): SeoSistrixImportDto {
    return {
      id: r.id,
      kind: r.kind as SeoSistrixCsvKind,
      filename: r.filename,
      domain: r.domain,
      keyword: r.keyword,
      country: r.country,
      rows: r.rows,
      skipped: r.skipped,
      createdAt: r.createdAt.toISOString(),
      createdBy,
    };
  }
}
