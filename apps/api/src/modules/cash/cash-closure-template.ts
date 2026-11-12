import { CASH_DENOMINATIONS, CASH_MOVEMENT_LABELS, denominationLabel } from '@storageos/shared';

import { formatEur } from '../../common/format';

import type { CashClosureDto, CashMethodKey } from '@storageos/shared';

/**
 * Plantilla PURA del cierre de caja en PDF (sin Puppeteer), para imprimirlo y
 * firmarlo: de dónde sale el efectivo esperado, el recuento por billetes y
 * monedas, la diferencia y las firmas. Vive aparte del servicio para probarla
 * sin lanzar el navegador.
 */
export interface CashClosurePdfData {
  businessName: string;
  /** Nombre del local, o null si es la caja de toda la empresa. */
  facilityName: string | null;
  /** «11 de noviembre de 2026». */
  dateLabel: string;
  /** «11/11/2026, 20:15» (hora del negocio). */
  closedAtLabel: string;
  reopenedAtLabel: string | null;
  closure: CashClosureDto;
}

const METHOD_LABELS: Record<CashMethodKey, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  bizum: 'Bizum',
  sepaDebit: 'Domiciliación SEPA',
  bankTransfer: 'Transferencia',
  other: 'Otros',
};

function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const eur = (n: number) => esc(formatEur(n));

export function renderCashClosureHtml(data: CashClosurePdfData): string {
  const c = data.closure;
  const b = c.breakdown;
  const rows: string[] = [];
  if (b) {
    rows.push(row('Cobros en efectivo', b.cashIn));
    if (b.cashRefunds > 0) rows.push(row('Devoluciones en efectivo', -b.cashRefunds));
    if (b.depositReturnsCash > 0) {
      rows.push(row('Fianzas devueltas en efectivo', -b.depositReturnsCash));
    }
    for (const m of b.movements) {
      const sign = m.kind === 'bank_withdrawal' ? -1 : 1;
      rows.push(
        row(`${CASH_MOVEMENT_LABELS[m.kind]}${m.notes ? ` (${m.notes})` : ''}`, sign * m.amount),
      );
    }
  }
  rows.push(row('Efectivo esperado', c.expectedCash, true));

  const methodRows = b
    ? (Object.keys(METHOD_LABELS) as CashMethodKey[])
        .filter((k) => k === 'cash' || b.byMethod[k] !== 0)
        .map((k) => row(METHOD_LABELS[k], b.byMethod[k]))
        .join('')
    : '';

  const counted = c.denominations
    ? CASH_DENOMINATIONS.filter((d) => (c.denominations?.[String(d)] ?? 0) > 0)
        .map((d) => {
          const units = c.denominations![String(d)]!;
          return `<tr><td>${esc(denominationLabel(d))}</td><td class="num">${units}</td><td class="num">${eur((d * units) / 100)}</td></tr>`;
        })
        .join('')
    : '';

  const diffClass = c.difference === 0 ? 'ok' : 'bad';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Cierre de caja ${esc(data.dateLabel)}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  td, th { padding: 4px 6px; border-bottom: 1px solid #ddd; text-align: left; }
  th { font-weight: 600; font-size: 11px; color: #555; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total td { font-weight: 700; border-top: 2px solid #111; }
  h2 { font-size: 14px; margin: 16px 0 0; }
  .summary { display: flex; gap: 12px; margin: 12px 0; }
  .box { flex: 1; border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; }
  .box .label { font-size: 11px; color: #555; }
  .box .value { font-size: 18px; font-weight: 700; }
  .ok { color: #047857; }
  .bad { color: #b91c1c; }
  .warn { border: 1px solid #f59e0b; background: #fffbeb; padding: 6px 8px; border-radius: 6px; margin: 8px 0; }
  .signatures { display: flex; gap: 24px; margin-top: 40px; }
  .signature { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 11px; color: #555; height: 60px; }
</style>
</head>
<body>
  <h1>Cierre de caja</h1>
  <div class="muted">${esc(data.businessName)} · ${esc(data.facilityName ?? 'Toda la empresa')}</div>
  <div class="muted">Día: <strong>${esc(data.dateLabel)}</strong></div>
  ${
    data.reopenedAtLabel
      ? `<div class="warn">Este cierre se reabrió el ${esc(data.reopenedAtLabel)}${c.reopenedByName ? ` por ${esc(c.reopenedByName)}` : ''}${c.reopenReason ? `: ${esc(c.reopenReason)}` : ''}. No es el cierre vigente de ese día.</div>`
      : ''
  }

  <div class="summary">
    <div class="box"><div class="label">Esperado</div><div class="value">${eur(c.expectedCash)}</div></div>
    <div class="box"><div class="label">Contado</div><div class="value">${eur(c.countedCash)}</div></div>
    <div class="box"><div class="label">Diferencia</div><div class="value ${diffClass}">${eur(c.difference)}</div></div>
  </div>

  <h2>De dónde sale el efectivo esperado</h2>
  <table>${rows.join('')}</table>

  ${methodRows ? `<h2>Cobrado ese día por forma de pago</h2><table>${methodRows}</table>` : ''}

  ${
    counted
      ? `<h2>Recuento</h2>
  <table>
    <tr><th>Billete o moneda</th><th class="num">Unidades</th><th class="num">Importe</th></tr>
    ${counted}
    <tr class="total"><td colspan="2">Total contado</td><td class="num">${eur(c.countedCash)}</td></tr>
  </table>`
      : ''
  }

  ${c.notes ? `<h2>Notas</h2><p>${esc(c.notes)}</p>` : ''}

  <p class="muted">Cerrada por ${esc(c.closedByName ?? '—')} el ${esc(data.closedAtLabel)}.</p>

  <div class="signatures">
    <div class="signature">Firma de quien cierra la caja</div>
    <div class="signature">Firma de quien la revisa</div>
  </div>
</body>
</html>`;
}

function row(label: string, amount: number, total = false): string {
  return `<tr${total ? ' class="total"' : ''}><td>${esc(label)}</td><td class="num">${eur(amount)}</td></tr>`;
}
