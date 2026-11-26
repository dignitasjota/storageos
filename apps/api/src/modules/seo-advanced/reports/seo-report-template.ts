import {
  SEO_ALERT_SEVERITY_LABELS,
  SEO_ALERT_STATUS_LABELS,
  SEO_ALERT_TYPE_LABELS,
  SEO_CONVERSION_TYPE_LABELS,
  SEO_OPPORTUNITY_TYPE_LABELS,
  SEO_REPORT_KIND_LABELS,
  seoFmtInt,
  type SeoAlertStatus,
  type SeoOpportunityType,
  type SeoReportContentDto,
} from '@storageos/shared';

import { escapeHtml as esc } from '../../../common/tenant-email-layout';

const dec = (n: number | null, digits = 1) =>
  n === null ? '—' : String(Math.round(n * 10 ** digits) / 10 ** digits).replace('.', ',');
const pct = (ratio: number | null) => (ratio === null ? '—' : `${dec(ratio * 100, 1)} %`);
const variation = (p: number | null) => (p === null ? '' : `${p > 0 ? '+' : ''}${dec(p, 1)} %`);
const fmtDate = (d: string) => d.split('-').reverse().join('/');

/**
 * HTML del informe (para el PDF): lo mismo que se ve en el panel, en una
 * página imprimible. Todo el texto variable va escapado.
 */
export function renderSeoReportHtml(
  c: SeoReportContentDto,
  brand: { name: string; color: string },
): string {
  const td = 'padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:left';
  const th = `${td};color:#64748b;font-weight:600`;
  const table = (head: string[], rows: string[][]) =>
    rows.length === 0
      ? '<p class="muted">Nada que destacar.</p>'
      : `<table><tr>${head.map((h) => `<th style="${th}">${esc(h)}</th>`).join('')}</tr>${rows
          .map((r) => `<tr>${r.map((x) => `<td style="${td}">${esc(x)}</td>`).join('')}</tr>`)
          .join('')}</table>`;
  const t = c.totals;
  const p = c.previous;
  const kpis: [string, string, string][] = [
    ['Clics desde Google', seoFmtInt(t.clicks), variation(c.change?.clicksPct ?? null)],
    ['Veces que apareces', seoFmtInt(t.impressions), variation(c.change?.impressionsPct ?? null)],
    ['CTR', pct(t.ctr), p && p.ctr !== null && t.ctr !== null ? `antes ${pct(p.ctr)}` : ''],
    ['Posición media', dec(t.position), p && p.position !== null ? `antes ${dec(p.position)}` : ''],
  ];
  const conv = c.conversions.items;
  const section = (title: string, body: string) => `<h2>${esc(title)}</h2>${body}`;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;margin:32px}
    h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:22px 0 8px;color:${esc(brand.color)}}
    table{width:100%;border-collapse:collapse} .muted{color:#64748b;font-size:12px}
    .kpis{display:flex;gap:10px;flex-wrap:wrap} .kpi{border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;min-width:120px}
    .kpi b{display:block;font-size:18px} ul{padding-left:18px;margin:0} li{font-size:13px;margin-bottom:4px}
    .top{border-top:4px solid ${esc(brand.color)};padding-top:12px}
  </style></head><body><div class="top">
  <p class="muted">${esc(brand.name)} · Informe ${esc(SEO_REPORT_KIND_LABELS[c.period.kind].toLowerCase())} de SEO</p>
  <h1>${esc(c.project.name)}${c.project.domain ? ` · ${esc(c.project.domain)}` : ''}</h1>
  <p class="muted">Del ${fmtDate(c.period.from)} al ${fmtDate(c.period.to)}${
    c.comparable
      ? `, comparado con el ${fmtDate(c.period.previousFrom)} al ${fmtDate(c.period.previousTo)}`
      : ''
  }. Datos reales de Google Search Console${c.visibility.length ? ' y estimación de SISTRIX' : ''}.</p>
  ${section('Lo más importante', `<ul>${c.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`)}
  ${section(
    'Cifras clave',
    `<div class="kpis">${kpis
      .map(
        ([k, v, d]) =>
          `<div class="kpi"><span class="muted">${esc(k)}</span><b>${esc(v)}</b><span class="muted">${esc(d)}</span></div>`,
      )
      .join('')}</div>${
      c.complete ? '' : '<p class="muted">Google aún no ha dado todos los días del periodo.</p>'
    }`,
  )}
  ${
    c.conversions.scope
      ? section(
          'Lo que trae Google',
          table(
            ['Qué', 'Periodo', 'Anterior'],
            conv.map((i) => [
              SEO_CONVERSION_TYPE_LABELS[i.type],
              seoFmtInt(i.count),
              i.previous === null ? '—' : seoFmtInt(i.previous),
            ]),
          ) +
            `<p class="muted">Tasa de conversión: ${pct(c.conversions.rate)}${
              c.conversions.revenue !== null
                ? ` · Ingresos del primer pago: ${dec(c.conversions.revenue, 2)} €`
                : ''
            }.</p>`,
        )
      : ''
  }
  ${
    c.visibility.length
      ? section(
          'Visibilidad (estimación de SISTRIX)',
          table(
            ['Dominio', 'Ahora', 'Antes'],
            c.visibility.map((v) => [
              `${v.domain}${v.own ? ' (tú)' : ''}`,
              dec(v.value, 4),
              v.previous === null ? '—' : dec(v.previous, 4),
            ]),
          ),
        )
      : ''
  }
  ${section(
    'Palabras que más suben',
    table(
      ['Palabra', 'Posición', 'Antes', 'Clics'],
      c.keywordsUp.map((k) => [
        k.keyword,
        dec(k.position),
        dec(k.previousPosition),
        seoFmtInt(k.clicks),
      ]),
    ),
  )}
  ${section(
    'Palabras que más bajan',
    table(
      ['Palabra', 'Posición', 'Antes', 'Clics'],
      c.keywordsDown.map((k) => [
        k.keyword,
        dec(k.position),
        dec(k.previousPosition),
        seoFmtInt(k.clicks),
      ]),
    ),
  )}
  ${section(
    'Mejores oportunidades nuevas',
    table(
      ['Búsqueda', 'Tipo', 'Puntuación'],
      c.opportunities.map((o) => [
        o.query,
        SEO_OPPORTUNITY_TYPE_LABELS[o.type as SeoOpportunityType] ?? o.type,
        String(o.score),
      ]),
    ),
  )}
  ${section(
    'Por revisar',
    `<ul><li>Canibalizaciones abiertas: ${seoFmtInt(c.cannibalizationsOpen)}${
      c.cannibalizations.length
        ? ` (${c.cannibalizations.map((x) => esc(`«${x.query}»`)).join(', ')})`
        : ''
    }.</li><li>Páginas que no deberían estar en Google: ${seoFmtInt(c.indexFindingsOpen)}.</li><li>Tareas hechas en el periodo: ${seoFmtInt(c.tasksDone)}; atrasadas: ${seoFmtInt(c.tasksOverdue)}.</li></ul>`,
  )}
  ${
    c.technical
      ? section(
          'Técnico: indexación y velocidad',
          `<ul><li>URL inspeccionadas con Google: ${seoFmtInt(c.technical.inspected)} (indexadas: ${seoFmtInt(c.technical.indexed)}; no indexadas: ${seoFmtInt(c.technical.notIndexed)}; con otra canónica: ${seoFmtInt(c.technical.canonicalMismatch)}).</li><li>Páginas medidas con PageSpeed: ${seoFmtInt(c.technical.pagespeedUrls)}; lentas en el móvil: ${seoFmtInt(c.technical.slowUrls)}${
            c.technical.avgMobileScore !== null
              ? `; puntuación media en el móvil: ${seoFmtInt(c.technical.avgMobileScore)} de 100`
              : ''
          }.</li></ul>`,
        )
      : ''
  }
  ${
    c.changesWithResult.length
      ? section(
          'Actuaciones con resultado',
          table(
            ['Cambio', 'Fecha', 'Resultado'],
            c.changesWithResult.map((x) => [x.title, fmtDate(x.date), x.text]),
          ) + '<p class="muted">Coincide con el cambio; no quiere decir que lo haya causado.</p>',
        )
      : ''
  }
  ${section(
    'Alertas del periodo',
    table(
      ['Alerta', 'Gravedad', 'Estado'],
      c.alerts.map((a) => [
        `${SEO_ALERT_TYPE_LABELS[a.type]}: ${a.title}`,
        SEO_ALERT_SEVERITY_LABELS[a.severity],
        SEO_ALERT_STATUS_LABELS[a.status as SeoAlertStatus] ?? a.status,
      ]),
    ),
  )}
  </div></body></html>`;
}

/**
 * PDF mínimo válido para los tests (sin navegador): una página con el título.
 * En producción el PDF lo dibuja Puppeteer con `renderSeoReportHtml`.
 */
export function testSeoReportPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, ' ').slice(0, 80);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${44 + text.length} >>\nstream\nBT /F1 14 Tf 50 780 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
