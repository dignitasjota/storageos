import Papa from 'papaparse';

import type { N43Account } from './n43-parser';
import type { BankCsvMapping } from '@storageos/shared';

/**
 * Lector del CSV de movimientos que exporta la banca online (BBVA, Santander,
 * CaixaBank, Sabadell…): cada banco pone sus columnas, así que se reconocen por
 * su título («Fecha», «Concepto», «Importe», «Cargo»/«Abono», «Saldo») o se
 * indican a mano. Importes y fechas en formato español. Función pura.
 */

export interface BankCsvParse {
  /** Títulos de las columnas (para elegirlas a mano si no se reconocen). */
  headers: string[];
  /** Unas filas de ejemplo. */
  sample: string[][];
  mapping: BankCsvMapping | null;
  /** El extracto, con la misma forma que uno Norma 43. */
  account: N43Account | null;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const SYNONYMS: Record<keyof BankCsvMapping, string[]> = {
  valueDate: ['FECHA VALOR', 'F VALOR', 'VALOR', 'VALUE DATE'],
  date: [
    'FECHA OPERACION',
    'F OPERACION',
    'FECHA OPER',
    'FECHA CONTABLE',
    'F CONTABLE',
    'FECHA',
    'DATE',
  ],
  debit: ['CARGO', 'CARGOS', 'DEBE', 'GASTOS'],
  credit: ['ABONO', 'ABONOS', 'HABER', 'INGRESOS'],
  amount: ['IMPORTE', 'IMPORTE EUR', 'CANTIDAD', 'AMOUNT'],
  balance: ['SALDO', 'SALDO DISPONIBLE', 'BALANCE'],
  description: [
    'CONCEPTO',
    'DESCRIPCION',
    'MOVIMIENTO',
    'DETALLE',
    'CONCEPTO COMUN',
    'DESCRIPTION',
    'CONCEPT',
  ],
};

/** El orden importa: «Fecha valor» antes que «Fecha»; los importes antes que el concepto. */
const ORDER: (keyof BankCsvMapping)[] = [
  'valueDate',
  'date',
  'debit',
  'credit',
  'amount',
  'balance',
  'description',
];

function looksLikeHeader(row: string[]): boolean {
  const cells = row.map(norm);
  const hasDate = cells.some((c) => c.includes('FECHA') || c === 'DATE');
  const hasMoney = cells.some((c) =>
    ['IMPORTE', 'CARGO', 'ABONO', 'DEBE', 'HABER', 'CANTIDAD', 'AMOUNT'].some((k) =>
      ` ${c} `.includes(` ${k}`),
    ),
  );
  return hasDate && hasMoney;
}

/** Reconoce las columnas por su título. */
function autoMapping(headers: string[]): BankCsvMapping | null {
  const cells = headers.map(norm);
  const used = new Set<number>();
  const found: Partial<Record<keyof BankCsvMapping, number>> = {};
  for (const key of ORDER) {
    const syns = SYNONYMS[key];
    let idx = cells.findIndex((c, i) => !used.has(i) && syns.includes(c));
    if (idx < 0) {
      idx = cells.findIndex(
        (c, i) => !used.has(i) && syns.some((s) => ` ${c} `.includes(` ${s} `)),
      );
    }
    if (idx >= 0) {
      found[key] = idx;
      used.add(idx);
    }
  }
  if (found.date === undefined && found.valueDate !== undefined) {
    found.date = found.valueDate;
    delete found.valueDate;
  }
  if (found.date === undefined || found.description === undefined) return null;
  if (found.amount === undefined && found.debit === undefined && found.credit === undefined) {
    return null;
  }
  return found as BankCsvMapping;
}

/** «1.234,56» · «-45,00» · «(12,30)» · «1,234.56» · «45.00 €» → céntimos. */
export function parseCsvAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.replace(/EUR|€|\s/gi, '');
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    // Con tres cifras detrás, la coma separa los miles («1,234»).
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 ? s.split(',').join('') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    if (decimals === 3) s = s.split('.').join('');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/** «05/11/2026», «5-11-26», «2026-11-05» (con o sin hora) → `2026-11-05`. */
export function parseCsvDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s);
  if (match) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
    if (y < 100) y += 2000;
  } else {
    match = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/.exec(s);
    if (!match) return null;
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function parseBankCsv(content: string, mapping?: BankCsvMapping): BankCsvParse {
  const parsed = Papa.parse<string[]>(content.replace(/^\uFEFF/, ''), {
    skipEmptyLines: 'greedy',
  });
  const rows = parsed.data.filter((r) => r.some((c) => c.trim() !== ''));
  const headerIndex = Math.max(
    0,
    rows.slice(0, 20).findIndex((r) => looksLikeHeader(r)),
  );
  const headers = (rows[headerIndex] ?? []).map((h) => h.trim());
  const data = rows.slice(headerIndex + 1);
  const sample = data.slice(0, 5);
  const map = mapping ?? autoMapping(headers);
  if (!map) return { headers, sample, mapping: null, account: null };

  // La cuenta: un IBAN en las líneas de antes de los títulos.
  const preamble = rows.slice(0, headerIndex).flat().join(' ');
  const iban = /\bES\d{2}(?:\s?\d{4}){5}\b/.exec(preamble.toUpperCase())?.[0]?.replace(/\s/g, '');

  const warnings: string[] = [];
  let skipped = 0;
  type Row = {
    date: string;
    valueDate: string | null;
    amount: number;
    text: string;
    balance: number | null;
  };
  let out: Row[] = [];
  for (const r of data) {
    const date = parseCsvDate(r[map.date]);
    if (!date) {
      // Pies de página («Saldo final…») y filas sin fecha.
      if ((r[map.date] ?? '').trim() !== '') skipped++;
      continue;
    }
    let amount: number | null;
    if (map.amount !== undefined) {
      amount = parseCsvAmount(r[map.amount]);
    } else {
      const debit = map.debit !== undefined ? parseCsvAmount(r[map.debit]) : null;
      const credit = map.credit !== undefined ? parseCsvAmount(r[map.credit]) : null;
      amount =
        debit === null && credit === null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (amount === null || amount === 0) {
      skipped++;
      continue;
    }
    out.push({
      date,
      valueDate: map.valueDate !== undefined ? parseCsvDate(r[map.valueDate]) : null,
      amount,
      text: (r[map.description] ?? '').replace(/\s+/g, ' ').trim(),
      balance: map.balance !== undefined ? parseCsvAmount(r[map.balance]) : null,
    });
  }
  if (out.length === 0) {
    return { headers, sample, mapping: map, account: null };
  }
  // La banca suele dar lo más reciente primero: se ordena del más antiguo.
  if (out[0]!.date > out[out.length - 1]!.date) out = out.reverse();
  if (skipped > 0) {
    warnings.push(
      `${skipped} ${skipped === 1 ? 'fila no se ha leído' : 'filas no se han leído'} (sin fecha o sin importe válidos).`,
    );
  }
  const withBalance = out.every((r) => r.balance !== null);
  let initialBalance = 0;
  let finalBalance = out.reduce((s, r) => s + r.amount, 0);
  if (withBalance) {
    initialBalance = out[0]!.balance! - out[0]!.amount;
    finalBalance = out[out.length - 1]!.balance!;
    let mismatches = 0;
    for (let k = 1; k < out.length; k++) {
      if (out[k - 1]!.balance! + out[k]!.amount !== out[k]!.balance!) mismatches++;
    }
    if (mismatches > 0) {
      warnings.push(
        `Los saldos del fichero no cuadran con los importes en ${mismatches} ${mismatches === 1 ? 'movimiento' : 'movimientos'}.`,
      );
    }
  }
  return {
    headers,
    sample,
    mapping: map,
    account: {
      accountLabel: iban ? `IBAN ····${iban.slice(-4)}` : '',
      currency: 'EUR',
      startDate: out[0]!.date,
      endDate: out[out.length - 1]!.date,
      initialBalance,
      finalBalance,
      balancesKnown: withBalance,
      warnings,
      transactions: out.map((r) => ({
        operationDate: r.date,
        valueDate: r.valueDate,
        amount: r.amount,
        conceptCommon: '',
        conceptOwn: '',
        reference1: '',
        reference2: '',
        documentNumber: '',
        description: r.text,
      })),
    },
  };
}
