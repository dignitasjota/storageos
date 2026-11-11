/**
 * Parser del fichero **Norma 43 / Cuaderno 43 (AEB)**: extracto bancario de
 * cuenta. Registros de 80 posiciones (las posiciones van de 1 a 80):
 *
 * - `11` cabecera de cuenta: entidad 3-6, oficina 7-10, cuenta 11-20, fecha
 *   inicial 21-26, fecha final 27-32, debe/haber del saldo 33, saldo inicial
 *   34-47, divisa 48-50, modalidad 51, nombre abreviado 52-77.
 * - `22` movimiento: oficina de origen 7-10, fecha de operación 11-16, fecha
 *   valor 17-22, concepto común 23-24, concepto propio 25-27, debe/haber 28,
 *   importe 29-42, documento 43-52, referencia 1 53-64, referencia 2 65-80.
 * - `23` concepto complementario (hasta 5 por movimiento): código 3-4 y dos
 *   textos de 38 caracteres en 5-42 y 43-80.
 * - `24` equivalencia de divisa (se ignora).
 * - `33` final de cuenta: nº de apuntes al debe 21-25, total debe 26-39, nº de
 *   apuntes al haber 40-44, total haber 45-58, debe/haber del saldo 59, saldo
 *   final 60-73, divisa 74-76.
 * - `88` fin de fichero: nº de registros 21-26.
 *
 * Importes: 14 dígitos con 2 decimales implícitos → se devuelven en **céntimos**.
 * Signo: debe (`1`) = cargo (negativo), haber (`2`) = abono (positivo).
 * Fechas: `AAMMDD` → ISO `20AA-MM-DD` (o `null` si no es válida).
 */

export interface N43Transaction {
  operationDate: string | null;
  valueDate: string | null;
  /** céntimos con signo: + abono, − cargo. */
  amount: number;
  conceptCommon: string;
  conceptOwn: string;
  reference1: string;
  reference2: string;
  documentNumber: string;
  description: string;
}

export interface N43Account {
  accountLabel: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  initialBalance: number;
  finalBalance: number;
  transactions: N43Transaction[];
  /** Lo que no cuadra en el fichero (saldos, totales, registros que faltan). */
  warnings: string[];
}

/** Campo por posición 1-based, recortado. */
function field(line: string, start: number, len: number): string {
  return line.substring(start - 1, start - 1 + len).trim();
}

function toCents(digits: string): number {
  const n = parseInt(digits.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function toInt(digits: string): number | null {
  if (!/^\d+$/.test(digits)) return null;
  return parseInt(digits, 10);
}

function toIsoDate(aammdd: string): string | null {
  if (!/^\d{6}$/.test(aammdd) || aammdd === '000000') return null;
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  // Una fecha imposible (31 de febrero) no se da por buena.
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  return date.toISOString().slice(0, 10);
}

function eur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

const CURRENCY_BY_CODE: Record<string, string> = { '978': 'EUR', '840': 'USD', '826': 'GBP' };

/** Totales del registro 33 de una cuenta. */
interface Closing {
  debitCount: number | null;
  debitTotal: number;
  creditCount: number | null;
  creditTotal: number;
}

export interface N43File {
  accounts: N43Account[];
  /** Avisos del fichero entero (fin de fichero, registros sueltos). */
  warnings: string[];
}

export function parseN43File(content: string): N43File {
  const lines = content.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  const accounts: N43Account[] = [];
  const closings = new Map<N43Account, Closing>();
  const warnings: string[] = [];
  let current: N43Account | null = null;
  let recordCount = 0;
  let declaredRecords: number | null = null;
  let orphanMovements = 0;

  for (const raw of lines) {
    const line = raw.padEnd(80, ' ');
    const type = line.substring(0, 2);

    if (type === '88') {
      declaredRecords = toInt(field(line, 21, 6));
      continue;
    }
    recordCount += 1;

    if (type === '11') {
      const entity = field(line, 3, 4);
      const office = field(line, 7, 4);
      const account = field(line, 11, 10);
      const sign = field(line, 33, 1);
      const balance = toCents(field(line, 34, 14));
      current = {
        accountLabel: [entity, office, account].filter(Boolean).join(' '),
        currency: CURRENCY_BY_CODE[field(line, 48, 3)] ?? 'EUR',
        startDate: toIsoDate(field(line, 21, 6)),
        endDate: toIsoDate(field(line, 27, 6)),
        initialBalance: sign === '1' ? -balance : balance,
        finalBalance: 0,
        transactions: [],
        warnings: [],
      };
      accounts.push(current);
    } else if (type === '22') {
      if (!current) {
        orphanMovements += 1;
        continue;
      }
      const debeHaber = field(line, 28, 1);
      const amount = toCents(field(line, 29, 14));
      current.transactions.push({
        operationDate: toIsoDate(field(line, 11, 6)),
        valueDate: toIsoDate(field(line, 17, 6)),
        amount: debeHaber === '1' ? -amount : amount,
        conceptCommon: field(line, 23, 2),
        conceptOwn: field(line, 25, 3),
        documentNumber: field(line, 43, 10),
        reference1: field(line, 53, 12),
        reference2: field(line, 65, 16),
        description: '',
      });
    } else if (type === '23' && current && current.transactions.length > 0) {
      const tx = current.transactions[current.transactions.length - 1]!;
      const text = `${field(line, 5, 38)} ${field(line, 43, 38)}`.trim();
      tx.description = [tx.description, text].filter(Boolean).join(' ').trim();
    } else if (type === '33' && current) {
      const sign = field(line, 59, 1);
      const balance = toCents(field(line, 60, 14));
      current.finalBalance = sign === '1' ? -balance : balance;
      closings.set(current, {
        debitCount: toInt(field(line, 21, 5)),
        debitTotal: toCents(field(line, 26, 14)),
        creditCount: toInt(field(line, 40, 5)),
        creditTotal: toCents(field(line, 45, 14)),
      });
      current = null;
    }
    // '24' (divisa) y cualquier otro tipo se ignoran.
  }

  for (const acc of accounts) {
    const closing = closings.get(acc);
    const sum = acc.transactions.reduce((s, t) => s + t.amount, 0);
    if (!closing) {
      acc.warnings.push(
        'Al fichero le falta el final de la cuenta (registro 33): puede estar cortado.',
      );
      acc.finalBalance = acc.initialBalance + sum;
      continue;
    }
    if (acc.initialBalance + sum !== acc.finalBalance) {
      acc.warnings.push(
        `El saldo no cuadra: saldo inicial ${eur(acc.initialBalance)} más los movimientos (${eur(sum)}) no da el saldo final ${eur(acc.finalBalance)}.`,
      );
    }
    const debits = acc.transactions.filter((t) => t.amount < 0);
    const credits = acc.transactions.filter((t) => t.amount >= 0);
    const debitTotal = -debits.reduce((s, t) => s + t.amount, 0);
    const creditTotal = credits.reduce((s, t) => s + t.amount, 0);
    if (
      (closing.debitCount !== null && closing.debitCount !== debits.length) ||
      (closing.creditCount !== null && closing.creditCount !== credits.length) ||
      closing.debitTotal !== debitTotal ||
      closing.creditTotal !== creditTotal
    ) {
      acc.warnings.push(
        `Los totales del banco (${closing.creditCount ?? '?'} abonos por ${eur(closing.creditTotal)} y ${closing.debitCount ?? '?'} cargos por ${eur(closing.debitTotal)}) no coinciden con los movimientos leídos (${credits.length} abonos por ${eur(creditTotal)} y ${debits.length} cargos por ${eur(debitTotal)}).`,
      );
    }
  }
  if (orphanMovements > 0) {
    warnings.push(
      `${orphanMovements} movimiento(s) sin cabecera de cuenta (registro 11): no se han importado.`,
    );
  }
  if (accounts.length > 0 && declaredRecords === null) {
    warnings.push('Al fichero le falta el registro de fin (88): puede estar cortado.');
  } else if (
    declaredRecords !== null &&
    declaredRecords !== recordCount &&
    declaredRecords !== recordCount + 1
  ) {
    warnings.push(
      `El fichero dice tener ${declaredRecords} registros y tiene ${recordCount}: puede faltar alguno.`,
    );
  }
  return { accounts, warnings };
}

/** Solo las cuentas (compatibilidad con quien no necesita los avisos). */
export function parseN43(content: string): N43Account[] {
  return parseN43File(content).accounts;
}
