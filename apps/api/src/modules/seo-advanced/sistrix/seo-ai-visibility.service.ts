import { Injectable } from '@nestjs/common';
import {
  SEO_AI_ANSWER_MAX,
  SEO_AI_COUNTRY,
  seoAiBrandSubject,
  seoAiPromptGaps,
  seoAiPromptKey,
  seoAiVisibilityLostAlert,
  seoAiVisibilitySettingsOf,
  seoUrlHost,
  type SeoAiPromptDto,
  type SeoAiPromptRow,
  type SeoAiSourceDto,
  type SeoAiSubjectDto,
  type SeoAiSubjectType,
  type SeoAiTrackedPromptDto,
  type SeoAiVisibilityReportDto,
  type SeoAiVisibilitySettings,
  type SeoAlertCandidate,
  type SeoProviderKey,
  type SeoReportAiVisibilityDto,
  type UpdateSeoAiTrackedPromptsInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';

import { poolOfProject } from './sistrix-sync.service';

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

interface Subject {
  subjectType: SeoAiSubjectType;
  subject: string;
  own: boolean;
}

type PromptRow = {
  subjectType: string;
  subject: string;
  sampleDate: Date;
  prompt: string;
  promptKey: string;
  model: string;
  answer: string | null;
};

/**
 * Visibilidad en buscadores de IA de un proyecto (PR 12), con lo descargado
 * de `ai_check` en su «fondo» de SISTRIX: cuántos prompts tienes tú (tu
 * dominio principal y tu marca) frente a cada competidor y su evolución,
 * reparto por modelo, prompts en los que sale la competencia y tú no, fuentes
 * que citan las IA y las respuestas de los prompts que sigues. Todo es
 * estimación de SISTRIX; las respuestas son texto de terceros.
 */
@Injectable()
export class SeoAiVisibilityService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  private async context(owner: SeoOwner | undefined, projectId: string) {
    const p = await this.projects.resolveProject(owner, projectId);
    const competitors = await this.admin.seoCompetitor.findMany({
      where: { projectId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { domain: true },
    });
    const pool = poolOfProject(p);
    const primary = (p.domains.find((d) => d.role === 'primary') ?? p.domains[0])?.domain ?? null;
    const brand = seoAiBrandSubject(p.brandTerms);
    const own: Subject[] = [
      ...(primary ? [{ subjectType: 'domain' as const, subject: primary, own: true }] : []),
      ...(brand ? [{ subjectType: 'brand' as const, subject: brand, own: true }] : []),
    ];
    const ownDomains = new Set(p.domains.map((d) => d.domain));
    const subjects: Subject[] = [
      ...own,
      ...competitors
        .map((c) => c.domain.toLowerCase())
        .filter((d) => !ownDomains.has(d))
        .map((subject) => ({ subjectType: 'domain' as const, subject, own: false })),
    ];
    return { p, pool, primary, brand, own, subjects, ownDomains };
  }

  /** Prompts de cada sujeto agrupados por fecha de consulta (la más reciente primero). */
  private async promptsBySubject(pool: string | null, subjects: Subject[]) {
    if (subjects.length === 0) return new Map<string, Map<string, PromptRow[]>>();
    const rows = await this.admin.seoAiPrompt.findMany({
      where: {
        tenantId: pool,
        country: SEO_AI_COUNTRY,
        OR: subjects.map((s) => ({ subjectType: s.subjectType, subject: s.subject })),
      },
      orderBy: [{ sampleDate: 'desc' }, { rank: 'asc' }],
      take: 5000,
    });
    const out = new Map<string, Map<string, PromptRow[]>>();
    for (const r of rows) {
      const key = `${r.subjectType}|${r.subject}`;
      const byDate = out.get(key) ?? new Map<string, PromptRow[]>();
      const d = dateOnly(r.sampleDate);
      byDate.set(d, [...(byDate.get(d) ?? []), r]);
      out.set(key, byDate);
    }
    return out;
  }

  /** Los prompts propios (dominio y marca juntos) de cada fecha de consulta. */
  private ownByDate(
    own: Subject[],
    bySubject: Map<string, Map<string, PromptRow[]>>,
  ): Map<string, SeoAiPromptRow[]> {
    const out = new Map<string, SeoAiPromptRow[]>();
    for (const s of own) {
      for (const [date, rows] of bySubject.get(`${s.subjectType}|${s.subject}`) ?? []) {
        out.set(date, [
          ...(out.get(date) ?? []),
          ...rows.map((r) => ({ promptKey: r.promptKey, prompt: r.prompt, model: r.model })),
        ]);
      }
    }
    return out;
  }

  async report(owner: SeoOwner | undefined, projectId: string): Promise<SeoAiVisibilityReportDto> {
    const ctx = await this.context(owner, projectId);
    const { p, pool, own, subjects, ownDomains } = ctx;
    const settings = seoAiVisibilitySettingsOf(p.aiVisibilitySettings);

    // Resumen (`overview`) de cada sujeto: serie por fecha y modelos de la última.
    const overview = subjects.length
      ? await this.admin.seoAiVisibility.findMany({
          where: {
            tenantId: pool,
            country: SEO_AI_COUNTRY,
            OR: subjects.map((s) => ({ subjectType: s.subjectType, domain: s.subject })),
          },
          orderBy: { sampleDate: 'asc' },
        })
      : [];
    const subjectDtos: SeoAiSubjectDto[] = subjects.map((s) => {
      const rows = overview.filter(
        (o) => o.subjectType === s.subjectType && o.domain === s.subject,
      );
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      return {
        subjectType: s.subjectType,
        subject: s.subject,
        own: s.own,
        promptCount: last ? last.promptCount : null,
        previousCount: prev ? prev.promptCount : null,
        series: rows.map((r) => ({ date: dateOnly(r.sampleDate), promptCount: r.promptCount })),
        models: last ? ((last.models as { model: string; promptCount: number }[]) ?? []) : [],
        origin: last
          ? {
              provider: last.provider as SeoProviderKey,
              fetchedAt: last.fetchedAt.toISOString(),
              dataDate: dateOnly(last.sampleDate),
            }
          : null,
      };
    });

    // Prompts: los tuyos de la última consulta y los de la competencia que no tienes.
    const bySubject = await this.promptsBySubject(pool, subjects);
    const ownDates = this.ownByDate(own, bySubject);
    const dates = [...ownDates.keys()].sort().reverse();
    const latestDate = dates[0] ?? null;
    const previousDate = dates[1] ?? null;
    const trackedKeys = new Set(settings.trackedPrompts.map(seoAiPromptKey));
    const latestOwnRows: PromptRow[] = [];
    for (const s of own) {
      const byDate = bySubject.get(`${s.subjectType}|${s.subject}`);
      const d = byDate ? [...byDate.keys()].sort().reverse()[0] : undefined;
      if (d) latestOwnRows.push(...(byDate!.get(d) ?? []));
    }
    const seen = new Set<string>();
    const ownPrompts: SeoAiPromptDto[] = [];
    for (const r of latestOwnRows) {
      const k = `${r.promptKey}|${r.model}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ownPrompts.push({
        prompt: r.prompt,
        promptKey: r.promptKey,
        model: r.model,
        answer: r.answer ? r.answer.slice(0, SEO_AI_ANSWER_MAX) : null,
        tracked: trackedKeys.has(r.promptKey),
      });
    }
    const competitorPrompts = subjects
      .filter((s) => !s.own)
      .map((s) => {
        const byDate = bySubject.get(`${s.subjectType}|${s.subject}`);
        const d = byDate ? [...byDate.keys()].sort().reverse()[0] : undefined;
        return {
          subject: s.subject,
          prompts: (d ? (byDate!.get(d) ?? []) : []).map((r) => ({
            promptKey: r.promptKey,
            prompt: r.prompt,
            model: r.model,
          })),
        };
      });
    const gaps = seoAiPromptGaps({
      own: latestOwnRows.map((r) => ({ promptKey: r.promptKey, prompt: r.prompt, model: r.model })),
      competitors: competitorPrompts,
    });

    // Fuentes y marcas que compiten: lo tuyo (el dominio principal o, sin él, la marca).
    const sourceSubject = own[0] ?? null;
    let sources: SeoAiSourceDto[] = [];
    let competitorBrands: SeoAiSourceDto[] = [];
    if (sourceSubject) {
      const latest = await this.admin.seoAiSource.findFirst({
        where: {
          tenantId: pool,
          country: SEO_AI_COUNTRY,
          subjectType: sourceSubject.subjectType,
          subject: sourceSubject.subject,
        },
        orderBy: { sampleDate: 'desc' },
        select: { sampleDate: true },
      });
      if (latest) {
        const rows = await this.admin.seoAiSource.findMany({
          where: {
            tenantId: pool,
            country: SEO_AI_COUNTRY,
            subjectType: sourceSubject.subjectType,
            subject: sourceSubject.subject,
            sampleDate: latest.sampleDate,
          },
          orderBy: { count: 'desc' },
          take: 200,
        });
        const isOwn = (source: string) => {
          const host = seoUrlHost(source.includes('://') ? source : `https://${source}`);
          return [...ownDomains].some((d) => host === d || host.endsWith(`.${d}`));
        };
        const dto = (r: (typeof rows)[number]): SeoAiSourceDto => ({
          sourceType: r.sourceType as SeoAiSourceDto['sourceType'],
          source: r.source,
          count: r.count,
          own: r.sourceType === 'brand' ? false : isOwn(r.source),
        });
        sources = rows.filter((r) => r.sourceType !== 'brand').map(dto);
        competitorBrands = rows.filter((r) => r.sourceType === 'brand').map(dto);
      }
    }

    // Prompts que sigues: la última respuesta de cada modelo.
    const tracked: SeoAiTrackedPromptDto[] = [];
    if (settings.trackedPrompts.length) {
      const rows = await this.admin.seoAiPrompt.findMany({
        where: {
          tenantId: pool,
          country: SEO_AI_COUNTRY,
          subjectType: 'tracked',
          promptKey: { in: [...trackedKeys] },
        },
        orderBy: { sampleDate: 'desc' },
        take: 1000,
      });
      const needles = [...ownDomains, ...p.brandTerms.map((b) => b.toLowerCase())].filter(
        (n) => n.length >= 3,
      );
      for (const prompt of settings.trackedPrompts) {
        const key = seoAiPromptKey(prompt);
        const byModel = new Map<string, (typeof rows)[number]>();
        for (const r of rows)
          if (r.promptKey === key && !byModel.has(r.model)) byModel.set(r.model, r);
        const answers = [...byModel.values()].map((r) => ({
          model: r.model,
          answer: r.answer ? r.answer.slice(0, SEO_AI_ANSWER_MAX) : null,
          date: dateOnly(r.sampleDate),
        }));
        tracked.push({
          prompt,
          promptKey: key,
          answers,
          mentionsYou: answers.some((a) =>
            needles.some((n) => (a.answer ?? '').toLowerCase().includes(n)),
          ),
        });
      }
    }

    const lastRun = await this.admin.seoSyncRun.findFirst({
      where: { projectId, dataType: 'ai_visibility', status: 'done' },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });

    return {
      country: SEO_AI_COUNTRY,
      latestDate,
      previousDate,
      subjects: subjectDtos,
      ownPrompts,
      gaps,
      sources,
      citedPages: sources.filter((s) => s.own && s.sourceType === 'url'),
      competitorBrands,
      tracked,
      settings,
      lastRunAt: lastRun?.finishedAt?.toISOString() ?? null,
    };
  }

  /** Prompts que se siguen (sus respuestas, con `ai_prompt_answers` en la próxima consulta). */
  async setTrackedPrompts(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoAiTrackedPromptsInput,
  ): Promise<SeoAiVisibilitySettings> {
    await this.projects.resolveProject(owner, projectId);
    const settings: SeoAiVisibilitySettings = { trackedPrompts: input.prompts };
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { aiVisibilitySettings: settings as unknown as object },
    });
    return settings;
  }

  /** Alerta «Dejas de salir en los buscadores de IA» (PR 8): la última consulta frente a la anterior. */
  async lostAlert(projectId: string, minLost: number): Promise<SeoAlertCandidate | null> {
    const ctx = await this.context(undefined, projectId);
    if (ctx.own.length === 0) return null;
    const byDate = this.ownByDate(ctx.own, await this.promptsBySubject(ctx.pool, ctx.own));
    const dates = [...byDate.keys()].sort().reverse();
    if (dates.length < 2) return null;
    return seoAiVisibilityLostAlert({
      projectId,
      latestDate: dates[0]!,
      previousDate: dates[1]!,
      latest: byDate.get(dates[0]!) ?? [],
      previous: byDate.get(dates[1]!) ?? [],
      minLost,
    });
  }

  /** Lo del informe: la última consulta hasta el final del periodo. null sin datos. */
  async reportSummary(projectId: string, to: string): Promise<SeoReportAiVisibilityDto | null> {
    const ctx = await this.context(undefined, projectId);
    if (ctx.subjects.length === 0) return null;
    const bySubject = await this.promptsBySubject(ctx.pool, ctx.subjects);
    const byDate = this.ownByDate(ctx.own, bySubject);
    const dates = [...byDate.keys()]
      .filter((d) => d <= to)
      .sort()
      .reverse();
    const date = dates[0];
    if (!date) return null;
    const count = (rows: SeoAiPromptRow[] | undefined) =>
      new Set((rows ?? []).map((r) => r.promptKey)).size;
    const latest = byDate.get(date) ?? [];
    const prev = dates[1] ? (byDate.get(dates[1]) ?? []) : null;
    const now = new Set(latest.map((r) => r.promptKey));
    const lost = prev
      ? new Set(prev.filter((r) => !now.has(r.promptKey)).map((r) => r.promptKey)).size
      : 0;
    const competitors = ctx.subjects
      .filter((s) => !s.own)
      .map((s) => {
        const m = bySubject.get(`${s.subjectType}|${s.subject}`);
        const d = m
          ? [...m.keys()]
              .filter((x) => x <= to)
              .sort()
              .reverse()[0]
          : undefined;
        return {
          subject: s.subject,
          promptCount: d ? new Set((m!.get(d) ?? []).map((r) => r.promptKey)).size : 0,
        };
      })
      .sort((a, b) => b.promptCount - a.promptCount)
      .slice(0, 5);
    return { date, own: count(latest), previous: prev ? count(prev) : null, lost, competitors };
  }
}
