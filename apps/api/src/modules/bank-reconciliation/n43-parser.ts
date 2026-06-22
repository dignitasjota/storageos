/**
 * Parser del fichero **Norma 43 / Cuaderno 43 (AEB)** — extracto bancario de
 * cuenta. Registros de 80 posiciones:
 *
 * - `11` cabecera de cuenta (entidad, oficina, nº cuenta, fechas, saldo inicial)
 * - `22` movimiento (fechas operación/valor, conceptos, debe/haber, importe, refs)
 * - `23` concepto complementario (texto libre del movimiento anterior, hasta 5)
 * - `33` final de cuenta (totales + saldo final)
 * - `88` fin de fichero
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
}

/** Campo por posición 1-based, recortado. */
function field(line: string, start: number, len: number): string {
  return line.substring(start - 1, start - 1 + len).trim();
}

function toCents(digits: string): number {
  const n = parseInt(digits.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate(aammdd: string): string | null {
  if (!/^\d{6}$/.test(aammdd) || aammdd === '000000') return null;
  const yy = aammdd.slice(0, 2);
  const mm = aammdd.slice(2, 4);
  const dd = aammdd.slice(4, 6);
  if (mm < '01' || mm > '12' || dd < '01' || dd > '31') return null;
  return `20${yy}-${mm}-${dd}`;
}

const CURRENCY_BY_CODE: Record<string, string> = { '978': 'EUR', '840': 'USD', '826': 'GBP' };

export function parseN43(content: string): N43Account[] {
  const lines = content.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  const accounts: N43Account[] = [];
  let current: N43Account | null = null;

  for (const raw of lines) {
    const line = raw.padEnd(80, ' ');
    const type = line.substring(0, 2);

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
      };
      accounts.push(current);
    } else if (type === '22' && current) {
      const debeHaber = field(line, 24, 1);
      const amount = toCents(field(line, 25, 14));
      current.transactions.push({
        operationDate: toIsoDate(field(line, 7, 6)),
        valueDate: toIsoDate(field(line, 13, 6)),
        amount: debeHaber === '1' ? -amount : amount,
        conceptCommon: field(line, 19, 2),
        conceptOwn: field(line, 21, 3),
        documentNumber: field(line, 39, 10),
        reference1: field(line, 49, 12),
        reference2: field(line, 61, 16),
        description: '',
      });
    } else if (type === '23' && current && current.transactions.length > 0) {
      const tx = current.transactions[current.transactions.length - 1]!;
      const text = `${field(line, 5, 38)} ${field(line, 43, 38)}`.trim();
      tx.description = [tx.description, text].filter(Boolean).join(' ').trim();
    } else if (type === '33' && current) {
      const sign = field(line, 49, 1);
      current.finalBalance =
        sign === '1' ? -toCents(field(line, 50, 14)) : toCents(field(line, 50, 14));
    }
    // '88' (fin de fichero) y cualquier otro tipo se ignoran.
  }

  return accounts;
}
