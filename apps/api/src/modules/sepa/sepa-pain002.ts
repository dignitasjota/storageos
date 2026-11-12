/**
 * Lector del informe de estado de pagos (ISO 20022 `pain.002`, «Customer
 * Payment Status Report») con el que el banco responde a una remesa de
 * adeudos: qué adeudos rechaza o devuelve, y por qué (código AM04, MD06…).
 * Función pura, sin dependencias: tolera los prefijos de espacio de nombres y
 * las versiones 001.02/03/10 (misma estructura en lo que se usa aquí).
 */

export interface Pain002Transaction {
  /** La referencia del adeudo que pusimos en la remesa (`EndToEndId`). */
  endToEndId: string;
  /** RJCT (rechazado o devuelto), ACCP/ACSC/ACTC (aceptado), PDNG (pendiente)… */
  status: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  amountCents: number | null;
}

export interface Pain002PaymentInfo {
  id: string | null;
  status: string | null;
  reasonCode: string | null;
}

export interface Pain002Report {
  /** El identificador del fichero que respondía (el `MsgId` de la remesa). */
  originalMessageId: string | null;
  groupStatus: string | null;
  groupReasonCode: string | null;
  paymentInfos: Pain002PaymentInfo[];
  transactions: Pain002Transaction[];
}

const PREFIX = '(?:[A-Za-z0-9_.-]+:)?';

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${PREFIX}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${PREFIX}${name}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '');
  return out;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function first(xml: string, name: string): string | null {
  const b = blocks(xml, name)[0];
  if (b === undefined) return null;
  const text = decode(b);
  return text === '' ? null : text;
}

/** El motivo (código y texto) de un bloque con `StsRsnInf`. */
function reason(xml: string): { code: string | null; text: string | null } {
  const info = blocks(xml, 'StsRsnInf')[0];
  if (info === undefined) return { code: null, text: null };
  const rsn = blocks(info, 'Rsn')[0] ?? '';
  const code = first(rsn, 'Cd') ?? first(rsn, 'Prtry');
  const texts = blocks(info, 'AddtlInf').map(decode).filter(Boolean);
  return {
    code: code ? code.toUpperCase() : null,
    text: texts.length > 0 ? texts.join(' ') : null,
  };
}

function cents(text: string | null): number | null {
  if (!text) return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** null si el texto no es un informe pain.002. */
export function parsePain002(xml: string): Pain002Report | null {
  if (!/CstmrPmtStsRpt/.test(xml)) return null;
  const group = blocks(xml, 'OrgnlGrpInfAndSts')[0] ?? '';
  const groupReason = reason(group);
  const groupStatus = first(group, 'GrpSts');
  const paymentInfos: Pain002PaymentInfo[] = [];
  const transactions: Pain002Transaction[] = [];
  for (const pmt of blocks(xml, 'OrgnlPmtInfAndSts')) {
    // El estado del bloque, sin mirar dentro de cada adeudo.
    const head = pmt.replace(
      new RegExp(`<${PREFIX}TxInfAndSts[\\s\\S]*?</${PREFIX}TxInfAndSts>`, 'g'),
      '',
    );
    const pmtStatus = first(head, 'PmtInfSts');
    const pmtReason = reason(head);
    paymentInfos.push({
      id: first(head, 'OrgnlPmtInfId'),
      status: pmtStatus,
      reasonCode: pmtReason.code,
    });
    for (const tx of blocks(pmt, 'TxInfAndSts')) {
      const endToEndId = first(tx, 'OrgnlEndToEndId');
      if (!endToEndId) continue;
      const r = reason(tx);
      transactions.push({
        endToEndId,
        status: first(tx, 'TxSts') ?? pmtStatus ?? groupStatus,
        reasonCode: r.code ?? pmtReason.code ?? groupReason.code,
        reasonText: r.text,
        amountCents: cents(first(tx, 'InstdAmt') ?? first(tx, 'Amt')),
      });
    }
  }
  return {
    originalMessageId: first(group, 'OrgnlMsgId'),
    groupStatus,
    groupReasonCode: groupReason.code,
    paymentInfos,
    transactions,
  };
}

/** Estados con los que el banco dice que el adeudo no se cobra (o se devuelve). */
export function isRejectedStatus(status: string | null): boolean {
  return status === 'RJCT' || status === 'CANC';
}
