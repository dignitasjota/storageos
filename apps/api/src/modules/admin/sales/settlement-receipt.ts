import { SALES_COMMISSION_KIND_LABELS, type SalesCommissionKind } from '@storageos/shared';

import { escapeHtml } from '../../../common/tenant-email-layout';

export interface SettlementReceiptInput {
  repName: string;
  repEmail: string;
  month: string;
  total: number;
  paidAt: Date | null;
  paidByName: string | null;
  receivedAt: Date | null;
  receivedNote: string | null;
  note: string | null;
  items: {
    month: string;
    tenantName: string | null;
    kind: string;
    description: string;
    amount: number;
  }[];
}

const eur = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const when = (d: Date | null) =>
  d
    ? d.toLocaleString('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Justificante de una liquidación de comisiones pagada en efectivo. */
export function renderSettlementReceipt(r: SettlementReceiptInput): string {
  const rows = r.items
    .map(
      (i) => `<tr>
  <td>${escapeHtml(monthLabel(i.month))}</td>
  <td>${escapeHtml(i.tenantName ?? '—')}</td>
  <td>${escapeHtml(SALES_COMMISSION_KIND_LABELS[i.kind as SalesCommissionKind] ?? i.kind)}<br><span class="muted">${escapeHtml(i.description)}</span></td>
  <td class="num">${escapeHtml(eur(i.amount))}</td>
</tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
body{font-family:Helvetica,Arial,sans-serif;color:#0f172a;font-size:12px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#475569;margin:0 0 18px}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{border-bottom:1px solid #e2e8f0;padding:6px 4px;text-align:left;vertical-align:top}
th{font-size:11px;color:#475569;text-transform:uppercase}
.num{text-align:right;white-space:nowrap}
.muted{color:#64748b;font-size:11px}
.total{font-size:16px;font-weight:bold;text-align:right;margin-top:12px}
.box{border:1px solid #cbd5e1;border-radius:6px;padding:10px 12px;margin-top:18px}
</style></head><body>
<h1>Justificante de liquidación de comisiones</h1>
<p class="sub">TrasterOS · ${escapeHtml(monthLabel(r.month))}</p>
<p><strong>Comercial:</strong> ${escapeHtml(r.repName)} (${escapeHtml(r.repEmail)})</p>
<p><strong>Forma de pago:</strong> efectivo · <strong>Pagada:</strong> ${escapeHtml(when(r.paidAt))}${r.paidByName ? ` por ${escapeHtml(r.paidByName)}` : ''}</p>
${r.note ? `<p><strong>Nota:</strong> ${escapeHtml(r.note)}</p>` : ''}
<table>
<thead><tr><th>Mes</th><th>Cliente</th><th>Concepto</th><th class="num">Importe</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="total">Total: ${escapeHtml(eur(r.total))}</p>
<div class="box">
${
  r.receivedAt
    ? `<strong>Recibido por el comercial</strong> el ${escapeHtml(when(r.receivedAt))}.${r.receivedNote ? `<br>Nota: ${escapeHtml(r.receivedNote)}` : ''}`
    : 'Pendiente de que el comercial confirme que lo ha recibido.'
}
</div>
</body></html>`;
}
