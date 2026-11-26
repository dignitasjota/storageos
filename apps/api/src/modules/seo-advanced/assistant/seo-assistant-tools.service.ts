import { Injectable } from '@nestjs/common';
import {
  normalizeSeoKeyword,
  SEO_ASSISTANT_ACTION_LABELS,
  seoUntrusted,
  type SeoPageSpeedRunDto,
  type SeoPanelPeriod,
} from '@storageos/shared';

import { SeoCrawlViewsService } from '../crawler/seo-crawl-views.service';
import { SeoDiagnosticsService } from '../diagnostics/seo-diagnostics.service';
import { SeoOpportunitiesService } from '../opportunities/seo-opportunities.service';
import { SeoSiteChangesService } from '../plan/seo-site-changes.service';
import { SeoTasksService } from '../plan/seo-tasks.service';
import { SeoConversionsService } from '../reports/seo-conversions.service';
import { SeoPanelService } from '../seo-panel.service';
import { type SeoOwner } from '../seo-projects.service';
import { SeoSistrixDataService } from '../sistrix/seo-sistrix-data.service';
import { SeoInspectionService } from '../technical/seo-inspection.service';
import { SeoPageSpeedService } from '../technical/seo-pagespeed.service';

import {
  SEO_PROPOSAL_TOOLS,
  type SeoActionScope,
  SeoAssistantActionsService,
} from './seo-assistant-actions.service';

import type { AiToolDef } from '../../ai/ai-provider';

/**
 * Quién pregunta y sobre qué proyecto. `readOwner`: el tenant (solo el suyo) o
 * `undefined` (el super admin leyendo cualquier proyecto). `write`: solo si
 * esta persona puede cambiar el proyecto; sin él no se le ofrecen las
 * herramientas que proponen acciones.
 */
export interface SeoToolContext {
  readOwner: SeoOwner | undefined;
  projectId: string;
  conversationId: string;
  write: SeoActionScope | null;
  /** Acciones propuestas en esta vuelta (las rellena `execute`). */
  proposedActionIds: string[];
}

const PERIODS = ['7d', '28d', '90d'] as const;
const periodOf = (v: unknown): SeoPanelPeriod =>
  (PERIODS as readonly string[]).includes(String(v)) ? (v as SeoPanelPeriod) : '28d';
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};
const r1 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);
const pct = (n: number | null | undefined) => (n == null ? null : Math.round(n * 1000) / 10);
/** Texto que viene de fuera (búsquedas, competencia, páginas, Google): delimitado como dato. */
const ext = (s: string | null | undefined, max = 200) => seoUntrusted(s, max) || null;

const GSC = 'Google Search Console';

const READ_TOOLS: AiToolDef[] = [
  {
    name: 'seo_summary',
    description:
      'Resumen del periodo (clics, impresiones, CTR y posición media) del dominio principal frente al periodo anterior y al del año anterior, con la fecha de los últimos datos de Google.',
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: [...PERIODS] } },
    },
  },
  {
    name: 'seo_changes',
    description:
      'Búsquedas o páginas que más suben o bajan en clics frente al periodo anterior (variación de clics y de posición).',
    input_schema: {
      type: 'object',
      properties: {
        dimension: { type: 'string', enum: ['query', 'page'] },
        direction: { type: 'string', enum: ['down', 'up'] },
        period: { type: 'string', enum: [...PERIODS] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'seo_keyword',
    description:
      'Ficha de una palabra: evolución de los últimos 90 días, páginas que salen, URL objetivo, volumen y posición estimada de SISTRIX si la hay. Si no se sigue, sus datos de Search Console.',
    input_schema: {
      type: 'object',
      properties: { keyword: { type: 'string' } },
      required: ['keyword'],
    },
  },
  {
    name: 'seo_opportunities',
    description:
      'Oportunidades abiertas ordenadas por puntuación, con su motivo, la acción propuesta y el desglose de la puntuación.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'seo_diagnostics',
    description:
      'Canibalización (varias páginas propias para la misma búsqueda) o indexación (páginas que no deberían estar en Google), con resumen y las principales.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['cannibalization', 'indexing'] } },
      required: ['kind'],
    },
  },
  {
    name: 'seo_technical',
    description:
      'Inspecciones de URL de Google (indexada o no, canónica) o la velocidad (PageSpeed: puntuación de móvil y ordenador y Core Web Vitals).',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['inspections', 'pagespeed'] } },
      required: ['kind'],
    },
  },
  {
    name: 'seo_crawl',
    description: 'El último rastreo de la web: páginas, errores e incidencias abiertas más graves.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'seo_competitors',
    description:
      'Competidores seguidos con su visibilidad de SISTRIX (estimación, con la fecha del dato).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'seo_serp',
    description:
      'Primeros resultados de Google de una palabra seguida según SISTRIX (posición, dominio y URL), si ya están descargados.',
    input_schema: {
      type: 'object',
      properties: { keyword: { type: 'string' } },
      required: ['keyword'],
    },
  },
  {
    name: 'seo_conversions',
    description:
      'Lo que trae Google: reservas, contactos o altas desde los resultados orgánicos, por página de entrada.',
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: [...PERIODS] } },
    },
  },
  {
    name: 'seo_plan',
    description:
      'Actuaciones registradas con su antes y después (7, 28 y 90 días) y tareas SEO abiertas.',
    input_schema: { type: 'object', properties: {} },
  },
];

const PROPOSE_TOOLS: AiToolDef[] = [
  {
    name: 'seo_propose_task',
    description: `${SEO_ASSISTANT_ACTION_LABELS.create_task}. Solo la deja preparada: la persona la confirma.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['content', 'technical', 'links', 'local', 'other'] },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        url: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
        opportunityId: { type: 'string' },
        dueDate: { type: 'string', description: 'AAAA-MM-DD' },
      },
      required: ['title'],
    },
  },
  {
    name: 'seo_propose_change',
    description: `${SEO_ASSISTANT_ACTION_LABELS.register_change} (un cambio ya hecho en la web). Solo la deja preparada.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'AAAA-MM-DD' },
        type: {
          type: 'string',
          enum: [
            'title_meta',
            'content',
            'new_page',
            'internal_links',
            'redirect',
            'technical',
            'noindex',
            'target_url',
            'other',
          ],
        },
        title: { type: 'string' },
        description: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
        keywords: { type: 'array', items: { type: 'string' } },
        opportunityId: { type: 'string' },
      },
      required: ['date', 'type', 'title'],
    },
  },
  {
    name: 'seo_propose_opportunity',
    description: `${SEO_ASSISTANT_ACTION_LABELS.opportunity_in_progress}. Solo la deja preparada.`,
    input_schema: {
      type: 'object',
      properties: { opportunityId: { type: 'string' } },
      required: ['opportunityId'],
    },
  },
  {
    name: 'seo_propose_follow_keyword',
    description: `${SEO_ASSISTANT_ACTION_LABELS.follow_keyword} (añadirla a las palabras seguidas). Solo la deja preparada.`,
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        groupName: { type: 'string' },
        priority: { type: 'number', description: '1 alta · 2 media · 3 baja' },
      },
      required: ['keyword'],
    },
  },
];

/**
 * Herramientas del asistente de SEO. Las de lectura llaman a los mismos
 * servicios que las pantallas, con el mismo dueño (un tenant solo ve su
 * proyecto; el super admin, cualquiera), devuelven cifras reales con su origen
 * y su fecha, y delimitan como dato todo el texto que viene de fuera. Ninguna
 * escribe: las `seo_propose_*` solo dejan una acción para que la persona la
 * confirme, y solo se ofrecen a quien puede cambiar el proyecto.
 */
@Injectable()
export class SeoAssistantToolsService {
  constructor(
    private readonly panel: SeoPanelService,
    private readonly diagnostics: SeoDiagnosticsService,
    private readonly opportunities: SeoOpportunitiesService,
    private readonly crawl: SeoCrawlViewsService,
    private readonly inspections: SeoInspectionService,
    private readonly pagespeed: SeoPageSpeedService,
    private readonly sistrixData: SeoSistrixDataService,
    private readonly conversions: SeoConversionsService,
    private readonly changes: SeoSiteChangesService,
    private readonly tasks: SeoTasksService,
    private readonly actions: SeoAssistantActionsService,
  ) {}

  definitions(ctx: Pick<SeoToolContext, 'write'>): AiToolDef[] {
    return ctx.write ? [...READ_TOOLS, ...PROPOSE_TOOLS] : READ_TOOLS;
  }

  async execute(
    ctx: SeoToolContext,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const proposal = SEO_PROPOSAL_TOOLS[name];
    if (proposal) {
      // Sin permiso para cambiar el proyecto no se ofrece; si el modelo la pide igual, no.
      if (!ctx.write) return json({ error: 'No tienes permiso para cambiar este proyecto.' });
      const res = await this.actions.propose(ctx.write, ctx.conversationId, proposal, input);
      if (!res.ok) return json({ error: res.error });
      ctx.proposedActionIds.push(res.actionId);
      return json({
        preparada: true,
        resumen: res.summary,
        nota: 'La acción NO está hecha: la persona tiene que confirmarla en pantalla.',
      });
    }
    const data = await this.read(ctx, name, input);
    if (data === undefined) return json({ error: `Herramienta desconocida: ${name}` });
    return json(data);
  }

  private async read(
    ctx: SeoToolContext,
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const { readOwner: owner, projectId } = ctx;
    switch (name) {
      case 'seo_summary': {
        const d = await this.panel.dashboard(owner, projectId, { period: periodOf(input.period) });
        if (!d.domain || !d.lastDate) {
          return { origen: GSC, sinDatos: 'Aún no hay datos de Search Console de este proyecto.' };
        }
        const totals = (t: typeof d.current | null) =>
          t
            ? {
                clics: t.clicks,
                impresiones: t.impressions,
                ctrPct: pct(t.ctr),
                posicion: r1(t.position),
              }
            : null;
        return {
          origen: GSC,
          dominio: d.domain,
          ultimoDatoDeGoogle: d.lastDate,
          periodo: { desde: d.from, hasta: d.to, dias: d.days },
          actual: totals(d.current),
          anterior: d.previous
            ? { desde: d.previousFrom, hasta: d.previousTo, ...totals(d.previous) }
            : 'Sin datos completos del periodo anterior',
          añoAnterior: d.yearAgo
            ? { desde: d.yearAgoFrom, hasta: d.yearAgoTo, ...totals(d.yearAgo) }
            : 'Sin datos del mismo periodo del año anterior',
        };
      }
      case 'seo_changes': {
        const dimension = input.dimension === 'page' ? 'page' : 'query';
        const t = await this.panel.table(owner, projectId, dimension, {
          period: periodOf(input.period),
          sort: 'change',
          dir: input.direction === 'up' ? 'desc' : 'asc',
          offset: 0,
          limit: clamp(input.limit, 1, 25, 10),
        });
        if (!t.previousAvailable) {
          return {
            origen: GSC,
            periodo: { desde: t.from, hasta: t.to },
            sinDatos: 'No hay datos completos del periodo anterior: no se puede comparar.',
          };
        }
        return {
          origen: GSC,
          periodo: { desde: t.from, hasta: t.to },
          anterior: { desde: t.previousFrom, hasta: t.previousTo },
          filas: t.items.map((r) => ({
            [dimension === 'page' ? 'pagina' : 'busqueda']:
              dimension === 'page' ? r.key : ext(r.key),
            clics: r.clicks,
            clicsAntes: r.previousClicks,
            variacionClics: r.clicksChange,
            variacionPct: r.clicksPct == null ? null : Math.round(r.clicksPct * 10) / 10,
            posicion: r1(r.position),
            posicionAntes: r1(r.previousPosition),
            puestosQueSube: r1(r.positionDiff),
            impresiones: r.impressions,
          })),
        };
      }
      case 'seo_keyword':
        return this.keyword(owner, projectId, String(input.keyword ?? ''));
      case 'seo_opportunities': {
        const list = await this.opportunities.list(owner, projectId, {
          limit: clamp(input.limit, 1, 15, 8),
        });
        return {
          origen: 'Motor de oportunidades (Search Console y, si hay, SISTRIX)',
          calculado: list.calculatedAt,
          total: list.total,
          oportunidades: list.items.map((o) => ({
            id: o.id,
            tipo: o.type,
            busqueda: ext(o.query),
            pagina: o.page,
            urlObjetivo: o.targetUrl,
            puntuacion: o.score,
            confianzaPct: Math.round(o.confidence * 100),
            estado: o.status,
            motivo: o.reason,
            accion: o.action,
            fuentes: o.sources,
            factores: o.factors.map((f) => ({
              factor: f.label,
              puntos: r1(f.points),
              detalle: f.detail,
            })),
          })),
        };
      }
      case 'seo_diagnostics': {
        if (input.kind === 'indexing') {
          const [sum, list] = await Promise.all([
            this.diagnostics.indexSummary(owner, projectId),
            this.diagnostics.indexFindings(owner, projectId, {}),
          ]);
          return {
            origen: `${GSC} (aparece en el rendimiento; «confirmada» solo con la inspección de URL)`,
            calculado: sum.calculatedAt,
            abiertos: sum.open,
            porCategoria: sum.byCategory,
            principales: list.items.slice(0, 10).map((f) => ({
              url: f.url,
              categoria: f.category,
              impresiones: f.impressions,
              clics: f.clicks,
              motivo: f.reason,
              accion: f.action,
              google: f.inspection
                ? {
                    indexada: f.inspection.indexed,
                    mensaje: ext(f.inspection.reason),
                    inspeccionada: f.inspection.inspectedAt,
                  }
                : null,
            })),
          };
        }
        const [sum, list] = await Promise.all([
          this.diagnostics.cannibalizationSummary(owner, projectId),
          this.diagnostics.cannibalizations(owner, projectId, {}),
        ]);
        return {
          origen: GSC,
          calculado: sum.calculatedAt,
          abiertas: sum.open,
          porGravedad: sum.bySeverity,
          principales: list.items.slice(0, 8).map((c) => ({
            busqueda: ext(c.query),
            gravedad: c.severity,
            tipo: c.kind,
            urlObjetivo: c.targetUrl,
            motivo: c.reason,
            accion: c.action,
            paginas: c.pages.slice(0, 4).map((p) => ({
              pagina: p.page,
              impresiones: p.impressions,
              repartoPct: Math.round(p.impressionsShare * 100),
              posicion: r1(p.position),
            })),
          })),
        };
      }
      case 'seo_technical': {
        if (input.kind === 'pagespeed') {
          const ps = await this.pagespeed.list(owner, projectId);
          return {
            origen: 'PageSpeed Insights (Google)',
            urls: ps.urls.slice(0, 10).map((u) => ({
              url: u.url,
              movil: summarizeRun(u.mobile),
              ordenador: summarizeRun(u.desktop),
            })),
            pendientes: ps.pending,
          };
        }
        const ins = await this.inspections.list(owner, projectId);
        return {
          origen: 'Inspección de URL de Google',
          cuotaHoy: { usadas: ins.quota.used, tope: ins.quota.cap },
          inspecciones: ins.items.slice(0, 12).map((i) => ({
            url: i.url,
            estado: i.status,
            inspeccionada: i.inspectedAt,
            indexada: i.indexed,
            veredicto: i.verdict,
            cobertura: ext(i.coverageState),
            motivoNoIndexada: ext(i.notIndexedReason),
            canonicaDistinta: i.canonicalMismatch,
            ultimoRastreoDeGoogle: i.lastCrawlAt,
          })),
        };
      }
      case 'seo_crawl': {
        const [ov, issues] = await Promise.all([
          this.crawl.overview(owner, projectId),
          this.crawl.issues(owner, projectId, { view: 'open' }),
        ]);
        const last = ov.last;
        if (!last)
          return { origen: 'Rastreador de TrasterOS', sinDatos: 'La web aún no se ha rastreado.' };
        return {
          origen: 'Rastreador de TrasterOS (peticiones a la web del proyecto)',
          rastreo: {
            fecha: last.finishedAt ?? last.createdAt,
            estado: last.status,
            paginas: last.pagesCrawled,
            errores: last.errors,
          },
          incidenciasAbiertas: issues.total,
          principales: issues.items.slice(0, 12).map((i) => ({
            tipo: i.label,
            gravedad: i.severity,
            url: i.url,
            detalle: ext(i.detail),
            queHacer: i.how,
            nueva: i.isNew,
          })),
        };
      }
      case 'seo_competitors': {
        const [list, vis] = await Promise.all([
          this.sistrixData.competitors(owner, projectId),
          this.sistrixData.visibility(owner, projectId),
        ]);
        const own = vis.find((v) => v.own);
        return {
          origen: 'SISTRIX (estimación de visibilidad, no son visitas)',
          tuVisibilidad: own?.latest
            ? {
                dominio: own.domain,
                valor: own.latest.value,
                fecha: own.latest.dataDate ?? own.latest.fetchedAt,
              }
            : 'Sin dato de SISTRIX de tu dominio',
          competidores: list
            .filter((c) => c.isActive)
            .slice(0, 15)
            .map((c) => ({
              dominio: ext(c.domain, 120),
              nombre: ext(c.name, 120),
              visibilidad: c.visibility?.value ?? null,
              fecha: c.visibility ? (c.visibility.dataDate ?? c.visibility.fetchedAt) : null,
              palabras: c.keywordCount,
            })),
        };
      }
      case 'seo_serp': {
        const word = normalizeSeoKeyword(String(input.keyword ?? ''));
        const keywords = await this.sistrixData.keywords(owner, projectId);
        const k = keywords.find((x) => normalizeSeoKeyword(x.keyword) === word);
        if (!k) return { sinDatos: `«${word}» no está entre las palabras del proyecto.` };
        const serp = await this.sistrixData.serp(owner, projectId, k.id);
        if (serp.results.length === 0) {
          return {
            origen: 'SISTRIX',
            sinDatos: 'Sin resultados de Google descargados para esta palabra.',
          };
        }
        return {
          origen: 'SISTRIX (resultados de Google; solo dominio y URL)',
          fecha: serp.origin?.dataDate ?? serp.origin?.fetchedAt ?? null,
          resultados: serp.results.slice(0, 10).map((r) => ({
            posicion: r.position,
            dominio: ext(r.domain, 120),
            url: ext(r.url, 300),
            tuyo: r.own,
            competidor: r.competitor,
          })),
        };
      }
      case 'seo_conversions': {
        const c = await this.conversions.summary(owner, projectId, {
          period: periodOf(input.period),
        });
        return {
          origen: 'Conversiones de la web con origen Google orgánico (y clics de Search Console)',
          periodo: { desde: c.from, hasta: c.to },
          tasaHasta: c.rateTo,
          completo: c.complete,
          porTipo: c.types.map((t) => ({ tipo: t.type, total: t.count, antes: t.previous })),
          ingresos: c.revenue,
          porPagina: c.pages.slice(0, 10).map((p) => ({
            pagina: p.landing,
            conversiones: p.conversions,
            clics: p.clicks,
            tasaPct: pct(p.rate),
          })),
        };
      }
      case 'seo_plan': {
        const [changes, tasks] = await Promise.all([
          this.changes.list(owner, projectId, { limit: 8 }),
          this.tasks.list(owner, projectId, { statuses: ['todo', 'in_progress', 'review'] }),
        ]);
        return {
          origen:
            'Plan del proyecto (actuaciones y tareas) y Search Console para el antes y después',
          actuaciones: changes.items.map((c) => ({
            fecha: c.date,
            titulo: c.title,
            tipo: c.type,
            urls: c.urls,
            ventanas: c.windows.map((w) => ({
              dias: w.days,
              estado: w.status,
              disponibleEl: w.availableOn,
              veredicto: w.scope?.verdict ?? null,
              texto: w.scope?.text ?? null,
              nota: w.contextNote,
            })),
          })),
          tareasAbiertas: tasks.items.slice(0, 15).map((t) => ({
            titulo: t.title,
            estado: t.status,
            prioridad: t.priority,
            tipo: t.type,
            fechaLimite: t.dueDate,
            url: t.url,
          })),
        };
      }
      default:
        return undefined;
    }
  }

  private async keyword(owner: SeoOwner | undefined, projectId: string, raw: string) {
    const word = normalizeSeoKeyword(raw);
    if (word.length < 2) return { error: 'Falta la palabra.' };
    const list = await this.diagnostics.trackedKeywords(owner, projectId, { days: 28 });
    const k =
      list.items.find((x) => normalizeSeoKeyword(x.keyword) === word) ??
      list.items.find((x) => normalizeSeoKeyword(x.keyword).includes(word));
    if (!k) {
      const t = await this.panel.table(owner, projectId, 'query', {
        period: '90d',
        search: word,
        sort: 'clicks',
        offset: 0,
        limit: 5,
      });
      return {
        origen: GSC,
        seguida: false,
        nota: 'Esta palabra no está entre las seguidas: solo hay datos de Search Console.',
        periodo: { desde: t.from, hasta: t.to },
        busquedas: t.items.map((r) => ({
          busqueda: ext(r.key),
          clics: r.clicks,
          impresiones: r.impressions,
          posicion: r1(r.position),
        })),
      };
    }
    const d = await this.diagnostics.trackedKeyword(owner, projectId, k.id, { days: 90 });
    const withData = d.daily.filter((x) => x.impressions > 0);
    const first = withData[0];
    const last = withData[withData.length - 1];
    const s = d.sistrix.points[d.sistrix.points.length - 1];
    return {
      origen: GSC,
      seguida: true,
      palabra: ext(k.keyword),
      grupo: k.groupName,
      prioridad: k.priority,
      urlObjetivo: k.targetUrl,
      paginaQueEnseñaGoogle: k.googlePage,
      estadoUrlObjetivo: k.targetStatus,
      ultimos28Dias: {
        desde: list.from,
        hasta: list.to,
        clics: k.clicks,
        impresiones: k.impressions,
        posicion: r1(k.position),
        posicionAntes: r1(k.previousPosition),
      },
      evolucion90Dias: {
        desde: d.from,
        hasta: d.to,
        primerDiaConDatos: first ? { fecha: first.date, posicion: r1(first.position) } : null,
        ultimoDiaConDatos: last ? { fecha: last.date, posicion: r1(last.position) } : null,
        cambiosDePagina: d.pageChanges.slice(-5),
      },
      paginas: d.pages.slice(0, 5).map((p) => ({
        pagina: p.page,
        clics: p.clicks,
        impresiones: p.impressions,
        posicion: r1(p.position),
        esObjetivo: p.isTarget,
      })),
      volumen: k.volume,
      sistrix: s
        ? {
            origen: 'SISTRIX (posición nacional estimada)',
            posicion: s.position,
            fecha: s.date,
            url: ext(s.url, 300),
          }
        : 'Sin datos de SISTRIX de esta palabra',
    };
  }
}

function summarizeRun(run: SeoPageSpeedRunDto | null): unknown {
  if (!run) return null;
  return {
    puntuacion: run.scores.performance,
    fecha: run.analyzedAt ?? run.createdAt,
    laboratorio: { lcpMs: run.lab.lcpMs, cls: run.lab.cls },
    usuariosReales: run.field,
    error: run.error,
  };
}

/** Resultado de una herramienta: JSON con el recordatorio de cómo tratar lo externo. */
function json(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 12_000 ? `${text.slice(0, 12_000)}…(recortado)` : text;
}
