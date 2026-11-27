import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GscImportError,
  SEO_MASTER_MAX_BYTES,
  SEO_MASTER_MAX_ISSUES,
  SEO_MASTER_SHEETS,
  SEO_PLATFORM_COMPETITOR_LIMIT,
  SEO_PLATFORM_KEYWORD_LIMIT,
  SEO_TENANT_LIMITS,
  SeoMasterImportError,
  madridToday,
  masterDueDate,
  masterKeywordNotes,
  masterTaskDescription,
  masterTaskPriority,
  masterTaskTitle,
  masterTaskUrl,
  mergeMasterGscQueries,
  normalizeSeoDomain,
  normalizeSeoKeyword,
  parseGscExport,
  parseSeoMaster,
  type ParsedGscExport,
  type ParsedSeoMaster,
  type SeoKeywordGroupDto,
  type SeoKeywordIntent,
  type SeoMasterClusterRow,
  type SeoMasterCompetitorRow,
  type SeoMasterGscDto,
  type SeoMasterImportDetailDto,
  type SeoMasterImportDto,
  type SeoMasterIssue,
  type SeoMasterKeywordRow,
  type SeoMasterPlanRow,
  type SeoMasterPreviewDto,
  type SeoMasterRemoveResultDto,
  type SeoMasterRule,
  type SeoMasterSheet,
  type SeoMasterSheetResultDto,
  type SeoMasterSummaryRow,
  type SeoTaskPriority,
} from '@storageos/shared';

import { isUniqueViolation } from '../../../common/prisma-errors';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { xlsxSheets } from '../../imports/import-engine';
import { zipTooLarge } from '../gsc-import.reader';
import { personNames } from '../plan/seo-plan-links';
import { SeoImportsService, type SeoUploadedFile, type SiteDaysPlan } from '../seo-imports.service';
import {
  SeoProjectsService,
  type ProjectRow,
  type SeoActor,
  type SeoOwner,
} from '../seo-projects.service';
import { poolOfProject } from '../sistrix/sistrix-sync.service';

import type { Prisma } from '@storageos/database';

const day = (d: string) => new Date(`${d}T00:00:00Z`);
/** 2026-11-25 → 25/11/2026 (en los textos). */
const es = (d: string) => d.split('-').reverse().join('/');
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Campos del catálogo que el maestro solo rellena si están vacíos. */
const FILLABLE = ['groupName', 'intent', 'targetUrl', 'notes'] as const;
type Fillable = (typeof FILLABLE)[number];
type KeywordData = {
  groupName: string | null;
  intent: SeoKeywordIntent | null;
  targetUrl: string | null;
  priority: number;
  notes: string | null;
  isActive: boolean;
};

/** Cuenta por hoja lo que se crea, rellena, deja igual u omite (y por qué). */
class Tally {
  created = 0;
  updated = 0;
  unchanged = 0;
  skipped = 0;
  readonly notes: string[] = [];
  private readonly reasons = new Map<string, number>();

  constructor(
    readonly sheet: SeoMasterSheet,
    readonly rows: number,
  ) {}

  skip(reason: string) {
    this.skipped++;
    this.reason(reason);
  }

  reason(reason: string) {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  dto(): SeoMasterSheetResultDto {
    return {
      sheet: this.sheet,
      rows: this.rows,
      created: this.created,
      updated: this.updated,
      unchanged: this.unchanged,
      skipped: this.skipped,
      reasons: [...this.reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      notes: this.notes,
    };
  }
}

interface KeywordPlan {
  creates: { row: SeoMasterKeywordRow; data: KeywordData }[];
  fills: { row: SeoMasterKeywordRow; id: string; fields: Partial<Record<Fillable, string>> }[];
}

interface Plan {
  project: ProjectRow;
  pool: string | null;
  domain: { id: string; domain: string };
  fileName: string;
  fileHash: string;
  fileSize: number;
  importDate: string;
  master: ParsedSeoMaster;
  /** Keyword del diccionario: país y idioma del proyecto. */
  dictCountry: string;
  dictLanguage: string;
  keywords: KeywordPlan;
  metrics: {
    keyword: string;
    country: string;
    date: string;
    sistrix: NonNullable<SeoMasterKeywordRow['sistrix']>;
  }[];
  domainKeywords: {
    domain: string;
    keyword: string;
    position: number;
    url: string;
    country: string;
    date: string;
  }[];
  competitors: {
    creates: { row: SeoMasterCompetitorRow; isActive: boolean; notes: string | null }[];
    fills: { id: string; domain: string; notes: string }[];
  };
  groups: {
    creates: { row: SeoMasterClusterRow }[];
    fills: { id: string; name: string; fields: Record<string, string | number> }[];
  };
  tasks: { row: SeoMasterPlanRow; data: TaskData }[];
  gsc: { parsed: ParsedGscExport; days: SiteDaysPlan; addedQueries: number } | null;
  sheets: SeoMasterSheetResultDto[];
  issues: SeoMasterIssue[];
}

interface TaskData {
  title: string;
  description: string;
  type: string;
  status: string;
  priority: SeoTaskPriority;
  dueDate: string | null;
  url: string | null;
}

type ImportRow = Prisma.SeoMasterImportGetPayload<{
  include: { gscImports: { select: { id: true } } };
}>;

/**
 * Importación de los Excel maestros de SEO (PR 7): cada hoja va a su sitio
 * (catálogo de palabras, observaciones de SISTRIX, posiciones de la
 * competencia, competidores, grupos, tareas y Search Console) con las reglas
 * del propio maestro: nunca se pisa lo decidido a mano ni el histórico, y un
 * vacío no es un cero. Vista previa, confirmación, sin duplicados por la
 * huella del fichero, y borrar deshace lo que añadió y nadie ha tocado.
 */
@Injectable()
export class SeoMasterImportService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly gscImports: SeoImportsService,
  ) {}

  async preview(
    owner: SeoOwner,
    projectId: string,
    file: SeoUploadedFile | undefined,
  ): Promise<SeoMasterPreviewDto> {
    const plan = await this.plan(owner, projectId, file);
    return {
      fileName: plan.fileName,
      fileHash: plan.fileHash,
      domainId: plan.domain.id,
      domain: plan.domain.domain,
      extractedAt: plan.master.extractedAt,
      gscFrom: plan.master.gscFrom,
      gscTo: plan.master.gscTo,
      importDate: plan.importDate,
      summary: plan.master.summary,
      rules: plan.master.rules,
      sheets: plan.sheets,
      gsc: gscDto(plan.gsc),
      issues: plan.issues.slice(0, SEO_MASTER_MAX_ISSUES),
      issuesTotal: plan.issues.length,
    };
  }

  async create(
    owner: SeoOwner,
    projectId: string,
    file: SeoUploadedFile | undefined,
    actor: SeoActor,
  ): Promise<SeoMasterImportDto> {
    const plan = await this.plan(owner, projectId, file);
    let importId: string;
    try {
      importId = await this.admin.$transaction((tx) => this.write(tx, plan, owner, actor), {
        timeout: 180_000,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicate(null);
      throw err;
    }
    return this.get(owner, projectId, importId);
  }

  async list(owner: SeoOwner | undefined, projectId: string): Promise<SeoMasterImportDto[]> {
    await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoMasterImport.findMany({
      where: { projectId },
      include: { gscImports: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.toDtos(rows);
  }

  async get(owner: SeoOwner | undefined, projectId: string, importId: string) {
    await this.projects.resolveProject(owner, projectId);
    const [dto] = await this.toDtos([await this.findImport(projectId, importId)]);
    return dto!;
  }

  async detail(
    owner: SeoOwner | undefined,
    projectId: string,
    importId: string,
  ): Promise<SeoMasterImportDetailDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findImport(projectId, importId);
    const [dto] = await this.toDtos([row]);
    return {
      ...dto!,
      summary: row.summary as unknown as SeoMasterSummaryRow[],
      rules: row.rules as unknown as SeoMasterRule[],
      issues: row.issues as unknown as SeoMasterIssue[],
      groups: await this.groupsOf(projectId),
    };
  }

  /** Grupos del catálogo de un proyecto, con cuántas palabras tiene cada uno. */
  async groups(owner: SeoOwner | undefined, projectId: string): Promise<SeoKeywordGroupDto[]> {
    await this.projects.resolveProject(owner, projectId);
    return this.groupsOf(projectId);
  }

  /**
   * Borra la importación: sus observaciones y su Search Console se van con ella;
   * lo que creó (palabras, competidores, grupos y tareas) solo si nadie lo ha
   * cambiado después, y lo que rellenó vuelve a quedar vacío si sigue igual.
   */
  async remove(
    owner: SeoOwner,
    projectId: string,
    importId: string,
  ): Promise<SeoMasterRemoveResultDto> {
    await this.projects.resolveProject(owner, projectId);
    await this.findImport(projectId, importId);
    return this.admin.$transaction(
      async (tx) => {
        const items = await tx.seoMasterImportItem.findMany({ where: { importId } });
        const result: SeoMasterRemoveResultDto = { removed: 0, kept: 0, reverted: 0 };
        const created = (kind: string) => items.filter((i) => i.kind === kind);
        // Palabras creadas y sin tocar.
        const kwIds = created('keyword_created').map((i) => i.entityId);
        const keywords = await tx.seoProjectKeyword.findMany({ where: { id: { in: kwIds } } });
        const byKw = new Map(keywords.map((k) => [k.id, k]));
        const dropKw: string[] = [];
        for (const item of created('keyword_created')) {
          const k = byKw.get(item.entityId);
          if (!k) continue;
          const f = item.fields as Record<string, unknown>;
          const same =
            !k.strategyLocked &&
            k.groupName === f.groupName &&
            k.intent === f.intent &&
            k.targetUrl === f.targetUrl &&
            k.priority === f.priority &&
            k.notes === f.notes &&
            k.isActive === f.isActive;
          if (same) dropKw.push(k.id);
          else result.kept++;
        }
        if (dropKw.length) {
          result.removed += (
            await tx.seoProjectKeyword.deleteMany({ where: { id: { in: dropKw } } })
          ).count;
        }
        // Lo que rellenó en las que ya había: vuelve a vacío si sigue igual.
        for (const item of created('keyword_filled')) {
          for (const [field, value] of Object.entries(item.fields as Record<string, string>)) {
            const res = await tx.seoProjectKeyword.updateMany({
              where: { id: item.entityId, strategyLocked: false, [field]: value },
              data: { [field]: null },
            });
            result.reverted += res.count;
          }
        }
        // Competidores.
        const compIds = created('competitor_created').map((i) => i.entityId);
        const comps = await tx.seoCompetitor.findMany({ where: { id: { in: compIds } } });
        const byComp = new Map(comps.map((c) => [c.id, c]));
        const dropComp: string[] = [];
        for (const item of created('competitor_created')) {
          const c = byComp.get(item.entityId);
          if (!c) continue;
          const f = item.fields as Record<string, unknown>;
          if (c.name === null && c.notes === f.notes && c.isActive === f.isActive) {
            dropComp.push(c.id);
          } else result.kept++;
        }
        if (dropComp.length) {
          result.removed += (
            await tx.seoCompetitor.deleteMany({ where: { id: { in: dropComp } } })
          ).count;
        }
        for (const item of created('competitor_filled')) {
          const notes = (item.fields as Record<string, string | undefined>).notes ?? null;
          const res = await tx.seoCompetitor.updateMany({
            where: { id: item.entityId, notes },
            data: { notes: null },
          });
          result.reverted += res.count;
        }
        // Grupos.
        const groupIds = created('group_created').map((i) => i.entityId);
        const groups = await tx.seoKeywordGroup.findMany({ where: { id: { in: groupIds } } });
        const byGroup = new Map(groups.map((g) => [g.id, g]));
        const dropGroups: string[] = [];
        for (const item of created('group_created')) {
          const g = byGroup.get(item.entityId);
          if (!g) continue;
          const f = item.fields as Record<string, unknown>;
          if (g.priority === f.priority && g.targetUrl === f.targetUrl && g.notes === f.notes) {
            dropGroups.push(g.id);
          } else result.kept++;
        }
        if (dropGroups.length) {
          result.removed += (
            await tx.seoKeywordGroup.deleteMany({ where: { id: { in: dropGroups } } })
          ).count;
        }
        for (const item of created('group_filled')) {
          for (const [field, value] of Object.entries(item.fields as Record<string, unknown>)) {
            const res = await tx.seoKeywordGroup.updateMany({
              where: { id: item.entityId, [field]: value },
              data: { [field]: null },
            });
            result.reverted += res.count;
          }
        }
        // Tareas creadas y sin tocar.
        const taskIds = created('task_created').map((i) => i.entityId);
        const tasks = await tx.seoTask.findMany({ where: { id: { in: taskIds } } });
        const byTask = new Map(tasks.map((t) => [t.id, t]));
        const dropTasks: string[] = [];
        for (const item of created('task_created')) {
          const t = byTask.get(item.entityId);
          if (!t) continue;
          const f = item.fields as Record<string, unknown>;
          const same =
            t.title === f.title &&
            t.description === f.description &&
            t.type === f.type &&
            t.status === f.status &&
            t.priority === f.priority &&
            dateOnly(t.dueDate) === f.dueDate &&
            t.url === f.url &&
            t.assignedToUserId === null &&
            t.assignedToSuperAdminId === null &&
            t.publishDate === null &&
            t.changeId === null;
          if (same) dropTasks.push(t.id);
          else result.kept++;
        }
        if (dropTasks.length) {
          result.removed += (
            await tx.seoTask.deleteMany({ where: { id: { in: dropTasks } } })
          ).count;
        }
        // Las observaciones, la importación de Search Console y el registro se van con ella.
        const [metrics, domainKeywords] = await Promise.all([
          tx.seoKeywordMetric.count({ where: { masterImportId: importId } }),
          tx.seoDomainKeyword.count({ where: { masterImportId: importId } }),
        ]);
        result.removed += metrics + domainKeywords;
        await tx.seoMasterImport.delete({ where: { id: importId } });
        return result;
      },
      { timeout: 120_000 },
    );
  }

  // ------------------------------------------------------------- plan

  private async plan(
    owner: SeoOwner,
    projectId: string,
    file: SeoUploadedFile | undefined,
  ): Promise<Plan> {
    const project = await this.projects.resolveProject(owner, projectId);
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        code: 'seo_master_file_required',
        message: 'Sube el Excel maestro (.xlsx).',
      });
    }
    if (file.buffer.length > SEO_MASTER_MAX_BYTES) {
      throw new BadRequestException({
        code: 'seo_import_too_large',
        message: 'El fichero pasa de 20 MB.',
      });
    }
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.admin.seoMasterImport.findFirst({
      where: { projectId, fileHash },
      select: { createdAt: true },
    });
    if (existing) throw this.duplicate(existing.createdAt);
    const master = await this.read(file.buffer);
    const domain = project.domains.find((d) => normalizeSeoDomain(d.domain) === master.domain);
    if (!domain) {
      throw new BadRequestException({
        code: 'seo_master_domain_mismatch',
        message: `El maestro es de ${master.domain} y ese dominio no está en el proyecto (${project.domains
          .map((d) => d.domain)
          .join(', ')}). Añádelo como dominio o importa el maestro en su proyecto.`,
      });
    }
    const pool = poolOfProject(project);
    const importDate = madridToday();
    const issues = [...master.issues];
    const tallies = new Map<SeoMasterSheet, Tally>(
      SEO_MASTER_SHEETS.map((s) => [s, new Tally(s, master.sheetRows[s] ?? 0)]),
    );
    const t = (s: SeoMasterSheet) => tallies.get(s)!;
    for (const i of master.issues) {
      if (i.level === 'rejected') t(i.sheet).skip(i.reason);
      else t(i.sheet).reason(i.reason);
    }
    t('summary').notes.push(
      'Se guarda con la importación (dominio, fechas, totales y alcance) para verla en su ficha.',
    );
    t('rules').notes.push('Se guardan con la importación y se aplican al importar.');

    const dictCountry = project.country.toUpperCase();
    const dictLanguage = project.language.toLowerCase();
    const keywords = await this.planKeywords(project, master, t('keywords'));
    const metrics = await this.planMetrics(
      project,
      pool,
      master,
      importDate,
      dictCountry,
      dictLanguage,
      t('keywords'),
    );
    const domainKeywords = await this.planDomainKeywords(
      project,
      pool,
      master,
      domain.domain,
      t('rankings'),
      t('keywords'),
    );
    const competitors = await this.planCompetitors(project, master, t('competitors'));
    const groups = await this.planGroups(projectId, master, t('clusters'));
    const tasks = await this.planTasks(
      projectId,
      domain.id,
      domain.domain,
      master,
      importDate,
      t('plan'),
    );
    const gsc = await this.planGsc(domain.id, master, issues, t('gsc'));
    return {
      project,
      pool,
      domain: { id: domain.id, domain: domain.domain },
      fileName: (file.originalname || 'maestro-seo.xlsx').slice(0, 200),
      fileHash,
      fileSize: file.buffer.length,
      importDate,
      master,
      dictCountry,
      dictLanguage,
      keywords,
      metrics,
      domainKeywords,
      competitors,
      groups,
      tasks,
      gsc,
      sheets: SEO_MASTER_SHEETS.map((s) => t(s).dto()).filter(
        (s) => s.rows > 0 || s.sheet === 'summary',
      ),
      issues,
    };
  }

  private async read(buffer: Buffer): Promise<ParsedSeoMaster> {
    if (!isZip(buffer)) {
      throw new BadRequestException({
        code: 'seo_master_invalid',
        message: 'Sube el maestro tal cual, en Excel (.xlsx).',
      });
    }
    if (await zipTooLarge(buffer)) {
      throw new BadRequestException({
        code: 'seo_master_invalid',
        message: 'El fichero ocupa demasiado descomprimido.',
      });
    }
    let sheets: { name: string; rows: string[][] }[];
    try {
      sheets = await xlsxSheets(buffer);
    } catch {
      throw new BadRequestException({
        code: 'seo_master_invalid',
        message: 'No se ha podido leer el Excel. Comprueba que es el maestro en formato .xlsx.',
      });
    }
    try {
      return parseSeoMaster(sheets);
    } catch (err) {
      if (err instanceof SeoMasterImportError) {
        throw new BadRequestException({ code: 'seo_master_invalid', message: err.message });
      }
      throw err;
    }
  }

  private async planKeywords(
    project: ProjectRow,
    master: ParsedSeoMaster,
    tally: Tally,
  ): Promise<KeywordPlan> {
    const catalog = await this.admin.seoProjectKeyword.findMany({
      where: { projectId: project.id },
      include: { keyword: { select: { keyword: true } } },
    });
    const byWord = new Map(catalog.map((c) => [normalizeSeoKeyword(c.keyword.keyword), c]));
    const limit = project.tenantId ? SEO_TENANT_LIMITS.keywords : SEO_PLATFORM_KEYWORD_LIMIT;
    let total = catalog.length;
    const plan: KeywordPlan = { creates: [], fills: [] };
    let discarded = 0;
    for (const row of master.keywords) {
      const data: KeywordData = {
        groupName: row.group,
        intent: row.intent,
        targetUrl: row.targetUrl,
        priority: row.priority ?? 2,
        notes: masterKeywordNotes(row),
        isActive: !row.discard,
      };
      const prev = byWord.get(row.keyword);
      if (!prev) {
        if (total >= limit) {
          tally.skip(
            `No cabe en el catálogo: el proyecto puede tener ${limit} palabras como mucho.`,
          );
          continue;
        }
        total++;
        plan.creates.push({ row, data });
        if (row.discard) discarded++;
        tally.created++;
        continue;
      }
      if (prev.strategyLocked) {
        tally.skip('Fijada a mano: el maestro no la toca.');
        continue;
      }
      const fields: Partial<Record<Fillable, string>> = {};
      for (const f of FILLABLE) {
        const value = data[f];
        if (prev[f] === null && value) fields[f] = value;
      }
      if (Object.keys(fields).length) {
        plan.fills.push({ row, id: prev.id, fields });
        tally.updated++;
      } else tally.unchanged++;
    }
    if (discarded) {
      tally.notes.push(
        `${discarded} marcadas para descartar entran en el catálogo como «sin seguir» (no se piden a SISTRIX ni cuentan en el panel de palabras).`,
      );
    }
    return plan;
  }

  private async planMetrics(
    project: ProjectRow,
    pool: string | null,
    master: ParsedSeoMaster,
    importDate: string,
    dictCountry: string,
    dictLanguage: string,
    tally: Tally,
  ): Promise<Plan['metrics']> {
    const rows = master.keywords.filter((k) => k.sistrix);
    if (rows.length === 0) return [];
    const dict = await this.admin.seoKeyword.findMany({
      where: {
        keyword: { in: rows.map((r) => r.keyword) },
        country: dictCountry,
        language: dictLanguage,
      },
      select: { id: true, keyword: true },
    });
    const idOf = new Map(dict.map((d) => [d.keyword, d.id]));
    const ids = [...idOf.values()];
    const existing = ids.length
      ? await this.admin.seoKeywordMetric.findMany({
          where: { tenantId: pool, provider: 'manual_import', keywordId: { in: ids } },
          select: { keywordId: true, country: true, dataDate: true },
        })
      : [];
    const have = new Set(
      existing.map((m) => `${m.keywordId}|${m.country}|${dateOnly(m.dataDate)}`),
    );
    const out: Plan['metrics'] = [];
    let skipped = 0;
    for (const r of rows) {
      const country = (r.country ?? project.country).toLowerCase();
      const date = r.consultedAt ?? master.extractedAt ?? importDate;
      const id = idOf.get(r.keyword);
      if (id && have.has(`${id}|${country}|${date}`)) {
        skipped++;
        continue;
      }
      out.push({ keyword: r.keyword, country, date, sistrix: r.sistrix! });
    }
    if (out.length) {
      tally.notes.push(
        `${out.length} con métricas de SISTRIX: se guardan como observación (origen «Importado», con su fecha de consulta), sin tocar las que descargue SISTRIX. Las celdas vacías quedan sin dato; los ceros, como cero.`,
      );
    }
    if (skipped) {
      tally.notes.push(
        `${skipped} métricas de SISTRIX ya estaban importadas con la misma fecha: no se repiten.`,
      );
    }
    const gscRows = master.keywords.filter((k) => k.gsc).length;
    if (gscRows) {
      tally.notes.push(
        `${gscRows} con datos de Search Console: van con las pestañas GSC_* como agregado del periodo (nunca repartido por días).`,
      );
    }
    return out;
  }

  private async planDomainKeywords(
    project: ProjectRow,
    pool: string | null,
    master: ParsedSeoMaster,
    ownDomain: string,
    rankTally: Tally,
    kwTally: Tally,
  ): Promise<Plan['domainKeywords']> {
    type Candidate = Plan['domainKeywords'][number] & { own: boolean };
    const keyOf = (c: { domain: string; country: string; date: string; keyword: string }) =>
      `${c.domain}|${c.country}|${c.date}|${c.keyword}`;
    const candidates: Candidate[] = master.rankings.map((r) => ({
      domain: r.domain,
      keyword: r.keyword,
      position: r.position,
      url: r.url,
      country: r.country,
      date: r.date,
      own: false,
    }));
    const seen = new Set(candidates.map(keyOf));
    // La posición propia de SISTRIX (si no viene ya en Rankings_competencia).
    for (const k of master.keywords) {
      const date = k.consultedAt ?? master.extractedAt;
      if (k.ownPosition === null || !date) continue;
      const c: Candidate = {
        domain: ownDomain,
        keyword: k.keyword,
        position: k.ownPosition,
        url: '',
        country: (k.country ?? project.country).toLowerCase(),
        date,
        own: true,
      };
      if (seen.has(keyOf(c))) continue;
      seen.add(keyOf(c));
      candidates.push(c);
    }
    if (candidates.length === 0) return [];
    const existing = await this.admin.seoDomainKeyword.findMany({
      where: {
        tenantId: pool,
        provider: 'manual_import',
        domain: { in: [...new Set(candidates.map((c) => c.domain))] },
        sampleDate: { in: [...new Set(candidates.map((c) => c.date))].map(day) },
      },
      select: { domain: true, country: true, sampleDate: true, keyword: true },
    });
    const have = new Set(
      existing.map((e) =>
        keyOf({
          domain: e.domain,
          country: e.country,
          date: dateOnly(e.sampleDate)!,
          keyword: e.keyword,
        }),
      ),
    );
    const out: Plan['domainKeywords'] = [];
    let ownAdded = 0;
    for (const { own, ...c } of candidates) {
      if (have.has(keyOf(c))) {
        if (!own)
          rankTally.skip('Ya estaba importada con la misma fecha (el histórico no se repite).');
        continue;
      }
      out.push(c);
      if (own) ownAdded++;
      else rankTally.created++;
    }
    if (rankTally.created) {
      rankTally.notes.push(
        'Cada posición se guarda como observación de su fecha (origen «Importado»): es una muestra, no la página de resultados completa.',
      );
    }
    if (ownAdded) {
      kwTally.notes.push(
        `${ownAdded} con posición propia en SISTRIX: se guarda como posición de ${ownDomain} en esa fecha.`,
      );
    }
    return out;
  }

  private async planCompetitors(
    project: ProjectRow,
    master: ParsedSeoMaster,
    tally: Tally,
  ): Promise<Plan['competitors']> {
    const existing = await this.admin.seoCompetitor.findMany({ where: { projectId: project.id } });
    const byDomain = new Map(existing.map((c) => [c.domain, c]));
    const own = new Set(project.domains.map((d) => normalizeSeoDomain(d.domain)));
    const limit = project.tenantId ? SEO_TENANT_LIMITS.competitors : SEO_PLATFORM_COMPETITOR_LIMIT;
    let active = existing.filter((c) => c.isActive).length;
    const out: Plan['competitors'] = { creates: [], fills: [] };
    let suggested = 0;
    for (const row of master.competitors) {
      if (own.has(row.domain)) {
        tally.skip('Es un dominio del proyecto.');
        continue;
      }
      const notes = competitorNotes(row);
      const prev = byDomain.get(row.domain);
      if (prev) {
        if (prev.notes === null && notes) {
          out.fills.push({ id: prev.id, domain: row.domain, notes });
          tally.updated++;
        } else tally.unchanged++;
        continue;
      }
      const isActive = active < limit;
      if (isActive) active++;
      else suggested++;
      out.creates.push({ row, isActive, notes });
      tally.created++;
    }
    if (suggested) {
      tally.notes.push(
        `${suggested} entran como sugerencia (sin seguir): ya sigues ${limit} competidores, el máximo.`,
      );
    }
    return out;
  }

  private async planGroups(
    projectId: string,
    master: ParsedSeoMaster,
    tally: Tally,
  ): Promise<Plan['groups']> {
    const existing = await this.admin.seoKeywordGroup.findMany({ where: { projectId } });
    const byName = new Map(existing.map((g) => [g.name.toLowerCase(), g]));
    const out: Plan['groups'] = { creates: [], fills: [] };
    for (const row of master.clusters) {
      const prev = byName.get(row.name.toLowerCase());
      if (!prev) {
        out.creates.push({ row });
        tally.created++;
        continue;
      }
      const fields: Record<string, string | number> = {};
      if (prev.priority === null && row.priority !== null) fields.priority = row.priority;
      if (prev.targetUrl === null && row.targetUrl) fields.targetUrl = row.targetUrl;
      if (prev.notes === null && row.note) fields.notes = row.note;
      if (Object.keys(fields).length) {
        out.fills.push({ id: prev.id, name: prev.name, fields });
        tally.updated++;
      } else tally.unchanged++;
    }
    return out;
  }

  private async planTasks(
    projectId: string,
    domainId: string,
    domain: string,
    master: ParsedSeoMaster,
    importDate: string,
    tally: Tally,
  ): Promise<Plan['tasks']> {
    if (master.plan.length === 0) return [];
    const existing = await this.admin.seoTask.findMany({
      where: { projectId, domainId, externalRef: { in: master.plan.map((p) => p.ref) } },
      select: { externalRef: true },
    });
    const have = new Set(existing.map((e) => e.externalRef));
    const groupPriority = new Map(master.clusters.map((c) => [c.name.toLowerCase(), c.priority]));
    const out: Plan['tasks'] = [];
    for (const row of master.plan) {
      if (have.has(row.ref)) {
        tally.skip('Ya existe la tarea de este punto del plan (no se duplica ni se pisa).');
        continue;
      }
      out.push({
        row,
        data: {
          title: masterTaskTitle(row),
          description: masterTaskDescription(row),
          type: row.type,
          status: row.status,
          priority: masterTaskPriority(groupPriority.get(row.cluster.toLowerCase())),
          dueDate: masterDueDate(row.deadline, importDate),
          url: masterTaskUrl(domain, row.path),
        },
      });
      tally.created++;
    }
    if (out.length) {
      tally.notes.push(
        `La fecha límite cuenta desde el día de la importación (${es(importDate)}): «Semana N» = 7·N días y «Mes N» = N meses. Se puede cambiar en cada tarea.`,
      );
    }
    return out;
  }

  private async planGsc(
    domainId: string,
    master: ParsedSeoMaster,
    issues: SeoMasterIssue[],
    tally: Tally,
  ): Promise<Plan['gsc']> {
    if (master.gscSheets.length === 0) return null;
    let parsed: ParsedGscExport;
    try {
      parsed = parseGscExport(master.gscSheets);
    } catch (err) {
      if (!(err instanceof GscImportError)) throw err;
      issues.push({ sheet: 'gsc', line: 1, value: '', reason: err.message, level: 'rejected' });
      tally.skip(err.message);
      return null;
    }
    const addedQueries = mergeMasterGscQueries(parsed, master.keywords);
    const days = await this.gscImports.planSiteDays(domainId, parsed);
    for (const w of parsed.warnings) tally.reason(w);
    tally.created = days.toAdd.length;
    tally.unchanged = days.siteDaysApi + days.siteDaysImported;
    tally.notes.push(
      `Del ${es(parsed.periodFrom)} al ${es(parsed.periodTo)}: ${days.toAdd.length} días entran en los totales del sitio; ${days.siteDaysApi} ya los tiene la API (mandan los suyos)${days.siteDaysImported ? ` y ${days.siteDaysImported} vienen de otra importación` : ''}. El resto de pestañas se guardan como foto del periodo.`,
    );
    if (addedQueries) {
      tally.notes.push(
        `${addedQueries} palabras de Maestro_keywords con datos de Search Console que no estaban en GSC_consultas se añaden a las consultas del periodo.`,
      );
    }
    return { parsed, days, addedQueries };
  }

  // ------------------------------------------------------------ escritura

  private async write(
    tx: Prisma.TransactionClient,
    plan: Plan,
    owner: SeoOwner,
    actor: SeoActor,
  ): Promise<string> {
    const tenantId = owner;
    const projectId = plan.project.id;
    const created = await tx.seoMasterImport.create({
      data: {
        tenantId,
        projectId,
        domainId: plan.domain.id,
        fileName: plan.fileName,
        fileHash: plan.fileHash,
        fileSize: plan.fileSize,
        domain: plan.master.domain,
        extractedAt: plan.master.extractedAt ? day(plan.master.extractedAt) : null,
        gscFrom: plan.master.gscFrom ? day(plan.master.gscFrom) : null,
        gscTo: plan.master.gscTo ? day(plan.master.gscTo) : null,
        summary: plan.master.summary as unknown as Prisma.InputJsonValue,
        rules: plan.master.rules as unknown as Prisma.InputJsonValue,
        sheets: plan.sheets as unknown as Prisma.InputJsonValue,
        issues: plan.issues.slice(0, SEO_MASTER_MAX_ISSUES) as unknown as Prisma.InputJsonValue,
        issuesTotal: plan.issues.length,
        createdByUserId: actor.userId ?? null,
        createdBySuperAdminId: actor.superAdminId ?? null,
      },
      select: { id: true, createdAt: true },
    });
    const importId = created.id;
    const items: Prisma.SeoMasterImportItemCreateManyInput[] = [];
    const item = (kind: string, entityId: string, ref: string, fields: object) =>
      items.push({
        tenantId,
        importId,
        kind,
        entityId,
        ref: ref.slice(0, 300),
        fields: fields as Prisma.InputJsonValue,
      });

    // Diccionario de palabras (global): las del catálogo y las de las métricas.
    const words = [
      ...new Set([
        ...plan.keywords.creates.map((c) => c.row.keyword),
        ...plan.metrics.map((m) => m.keyword),
      ]),
    ];
    const idOf = new Map<string, string>();
    if (words.length) {
      await tx.seoKeyword.createMany({
        data: words.map((keyword) => ({
          keyword,
          country: plan.dictCountry,
          language: plan.dictLanguage,
        })),
        skipDuplicates: true,
      });
      const dict = await tx.seoKeyword.findMany({
        where: { keyword: { in: words }, country: plan.dictCountry, language: plan.dictLanguage },
        select: { id: true, keyword: true },
      });
      for (const d of dict) idOf.set(d.keyword, d.id);
    }

    // Catálogo: nuevas.
    const kwCreates = plan.keywords.creates.filter((c) => idOf.has(c.row.keyword));
    if (kwCreates.length) {
      const rows = await tx.seoProjectKeyword.createManyAndReturn({
        data: kwCreates.map((c) => ({
          tenantId,
          projectId,
          keywordId: idOf.get(c.row.keyword)!,
          ...c.data,
          source: 'master',
          masterImportId: importId,
        })),
        skipDuplicates: true,
        select: { id: true, keywordId: true },
      });
      const byKeywordId = new Map(kwCreates.map((c) => [idOf.get(c.row.keyword)!, c]));
      for (const r of rows) {
        const c = byKeywordId.get(r.keywordId)!;
        item('keyword_created', r.id, c.row.key, c.data);
      }
    }
    // Catálogo: solo lo vacío, campo a campo, si sigue vacío y no está fijada.
    for (const f of plan.keywords.fills) {
      const done: Record<string, string> = {};
      for (const [field, value] of Object.entries(f.fields)) {
        const res = await tx.seoProjectKeyword.updateMany({
          where: { id: f.id, strategyLocked: false, [field]: null },
          data: { [field]: value },
        });
        if (res.count > 0) done[field] = value;
      }
      if (Object.keys(done).length) item('keyword_filled', f.id, f.row.key, done);
    }

    // Observaciones de SISTRIX (sin pisar nada: filas nuevas con su proveedor y fecha).
    const metricRows = plan.metrics.flatMap((m) => {
      const keywordId = idOf.get(m.keyword);
      if (!keywordId) return [];
      return [
        {
          tenantId: plan.pool,
          keywordId,
          country: m.country,
          provider: 'manual_import',
          fetchedAt: day(m.date),
          dataDate: day(m.date),
          traffic: intOrNull(m.sistrix.traffic),
          clicks: intOrNull(m.sistrix.clicks),
          cpc: m.sistrix.cpc === null ? null : Math.min(99_999_999, Math.max(0, m.sistrix.cpc)),
          competition: intOrNull(m.sistrix.competition),
          masterImportId: importId,
        },
      ];
    });
    if (metricRows.length) await tx.seoKeywordMetric.createMany({ data: metricRows });

    // Posiciones de dominios (competencia y la propia).
    if (plan.domainKeywords.length) {
      await tx.seoDomainKeyword.createMany({
        data: plan.domainKeywords.map((d) => ({
          tenantId: plan.pool,
          domain: d.domain,
          country: d.country,
          provider: 'manual_import',
          sampleDate: day(d.date),
          fetchedAt: day(d.date),
          keyword: d.keyword,
          position: d.position,
          url: d.url,
          masterImportId: importId,
        })),
        skipDuplicates: true,
      });
    }

    // Competidores.
    if (plan.competitors.creates.length) {
      const rows = await tx.seoCompetitor.createManyAndReturn({
        data: plan.competitors.creates.map((c) => ({
          tenantId,
          projectId,
          domain: c.row.domain,
          notes: c.notes,
          isActive: c.isActive,
          source: 'master',
          masterImportId: importId,
        })),
        skipDuplicates: true,
        select: { id: true, domain: true, notes: true, isActive: true },
      });
      for (const r of rows) {
        item('competitor_created', r.id, r.domain, { notes: r.notes, isActive: r.isActive });
      }
    }
    for (const f of plan.competitors.fills) {
      const res = await tx.seoCompetitor.updateMany({
        where: { id: f.id, notes: null },
        data: { notes: f.notes },
      });
      if (res.count) item('competitor_filled', f.id, f.domain, { notes: f.notes });
    }

    // Grupos.
    if (plan.groups.creates.length) {
      const rows = await tx.seoKeywordGroup.createManyAndReturn({
        data: plan.groups.creates.map((g) => ({
          tenantId,
          projectId,
          name: g.row.name,
          priority: g.row.priority,
          targetUrl: g.row.targetUrl,
          notes: g.row.note || null,
          source: 'master',
          masterImportId: importId,
        })),
        skipDuplicates: true,
        select: { id: true, name: true, priority: true, targetUrl: true, notes: true },
      });
      for (const r of rows) {
        item('group_created', r.id, r.name, {
          priority: r.priority,
          targetUrl: r.targetUrl,
          notes: r.notes,
        });
      }
    }
    for (const g of plan.groups.fills) {
      const done: Record<string, string | number> = {};
      for (const [field, value] of Object.entries(g.fields)) {
        const res = await tx.seoKeywordGroup.updateMany({
          where: { id: g.id, [field]: null },
          data: { [field]: value },
        });
        if (res.count) done[field] = value;
      }
      if (Object.keys(done).length) item('group_filled', g.id, g.name, done);
    }

    // Tareas del plan (al final de su columna del tablero).
    if (plan.tasks.length) {
      const maxes = await tx.seoTask.groupBy({
        by: ['status'],
        where: { projectId },
        _max: { position: true },
      });
      const next = new Map(maxes.map((m) => [m.status, (m._max.position ?? -1) + 1]));
      const now = new Date();
      const rows = await tx.seoTask.createManyAndReturn({
        data: plan.tasks.map((task) => {
          const position = next.get(task.data.status) ?? 0;
          next.set(task.data.status, position + 1);
          return {
            tenantId,
            projectId,
            domainId: plan.domain.id,
            title: task.data.title,
            description: task.data.description,
            type: task.data.type,
            status: task.data.status,
            priority: task.data.priority,
            dueDate: task.data.dueDate ? day(task.data.dueDate) : null,
            url: task.data.url,
            position,
            completedAt: task.data.status === 'done' ? now : null,
            externalRef: task.row.ref,
            masterImportId: importId,
            createdByUserId: actor.userId ?? null,
            createdBySuperAdminId: actor.superAdminId ?? null,
          };
        }),
        select: { id: true, externalRef: true },
      });
      const byRef = new Map(plan.tasks.map((t) => [t.row.ref, t]));
      for (const r of rows) {
        const task = byRef.get(r.externalRef ?? '');
        if (task) item('task_created', r.id, task.row.ref, task.data);
      }
    }

    // Search Console: la misma importación de la PR 2, ligada a esta.
    if (plan.gsc) {
      await this.gscImports.writeImport(tx, {
        owner,
        projectId,
        domainId: plan.domain.id,
        fileName: `${plan.fileName} (Search Console)`.slice(0, 200),
        fileHash: createHash('sha256').update(`${plan.fileHash}:gsc`).digest('hex'),
        fileSize: plan.fileSize,
        format: 'xlsx',
        parsed: plan.gsc.parsed,
        days: plan.gsc.days,
        actor,
        masterImportId: importId,
      });
    }

    for (let i = 0; i < items.length; i += 1000) {
      await tx.seoMasterImportItem.createMany({ data: items.slice(i, i + 1000) });
    }
    return importId;
  }

  // ------------------------------------------------------------ lectura

  private async groupsOf(projectId: string): Promise<SeoKeywordGroupDto[]> {
    const [groups, counts] = await Promise.all([
      this.admin.seoKeywordGroup.findMany({
        where: { projectId },
        include: { masterImport: { select: { createdAt: true } } },
        orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      }),
      this.admin.seoProjectKeyword.groupBy({
        by: ['groupName'],
        where: { projectId },
        _count: { _all: true },
      }),
    ]);
    const count = new Map(counts.map((c) => [c.groupName ?? '', c._count._all]));
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      priority: g.priority,
      targetUrl: g.targetUrl,
      notes: g.notes,
      source: g.source === 'master' ? 'master' : 'manual',
      masterImportedAt: g.masterImport?.createdAt.toISOString() ?? null,
      keywords: count.get(g.name) ?? 0,
    }));
  }

  private async findImport(projectId: string, importId: string): Promise<ImportRow> {
    const row = await this.admin.seoMasterImport.findFirst({
      where: { id: importId, projectId },
      include: { gscImports: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
    return row;
  }

  private duplicate(when: Date | null): ConflictException {
    const date = when
      ? ` el ${when.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })}`
      : '';
    return new ConflictException({
      code: 'seo_master_duplicate',
      message: `Este maestro ya se importó${date}. Si quieres volver a cargarlo, borra antes esa importación.`,
    });
  }

  private async toDtos(rows: ImportRow[]): Promise<SeoMasterImportDto[]> {
    const names = await personNames(
      this.admin,
      rows.map((r) => r.createdByUserId),
      rows.map((r) => r.createdBySuperAdminId),
    );
    return rows.map((r) => ({
      id: r.id,
      domainId: r.domainId,
      domain: r.domain,
      fileName: r.fileName,
      extractedAt: dateOnly(r.extractedAt),
      gscFrom: dateOnly(r.gscFrom),
      gscTo: dateOnly(r.gscTo),
      sheets: r.sheets as unknown as SeoMasterSheetResultDto[],
      issuesTotal: r.issuesTotal,
      gscImportId: r.gscImports[0]?.id ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy:
        names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
    }));
  }
}

function intOrNull(n: number | null): number | null {
  return n === null ? null : Math.max(-2_000_000_000, Math.min(2_000_000_000, Math.round(n)));
}

function competitorNotes(row: SeoMasterCompetitorRow): string | null {
  const status = row.status.trim();
  const parts = [
    row.strategy.trim(),
    status && !/^datos obtenidos$/i.test(status) ? `(${status})` : '',
  ].filter(Boolean);
  return parts.length ? `Del maestro: ${parts.join(' ')}`.slice(0, 1000) : null;
}

function gscDto(gsc: Plan['gsc']): SeoMasterGscDto | null {
  if (!gsc) return null;
  return {
    periodFrom: gsc.parsed.periodFrom,
    periodTo: gsc.parsed.periodTo,
    language: gsc.parsed.language,
    tabRows: Object.fromEntries(gsc.parsed.tabs.map((t) => [t.dimension, t.rows.length])),
    filters: gsc.parsed.filters,
    filtered: gsc.parsed.filtered,
    filterReasons: gsc.parsed.filterReasons,
    warnings: gsc.parsed.warnings,
    siteDaysToAdd: gsc.days.toAdd.length,
    siteDaysApi: gsc.days.siteDaysApi,
    siteDaysImported: gsc.days.siteDaysImported,
    addedQueries: gsc.addedQueries,
  };
}
