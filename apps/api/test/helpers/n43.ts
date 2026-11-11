import { randomInt } from 'node:crypto';

/**
 * Extractos Cuaderno 43 para las pruebas, construidos campo a campo con la
 * tabla de la norma AEB (cada campo con su ancho), no con posiciones.
 */
type N43Field = [value: string | number, width: number, kind?: 'n'];

/** Un registro de 80 caracteres: alfanuméricos a la izquierda, números con ceros. */
export function n43Record(fields: N43Field[]): string {
  const line = fields
    .map(([value, width, kind]) =>
      kind === 'n'
        ? String(value).padStart(width, '0').slice(-width)
        : String(value).padEnd(width, ' ').slice(0, width),
    )
    .join('');
  if (line.length !== 80) throw new Error(`Registro N43 de ${line.length} caracteres`);
  return line;
}

export interface N43Movement {
  /** Céntimos con signo: + abono, − cargo. */
  amountCents: number;
  /** AAMMDD. */
  date?: string;
  valueDate?: string;
  common?: string;
  own?: string;
  documentNumber?: string | number;
  reference1?: string;
  reference2?: string;
  /** Texto del registro 23 (concepto complementario). */
  concept?: string;
}

const ACCOUNT: N43Field[] = [
  ['2100', 4, 'n'],
  ['0418', 4, 'n'],
  ['0200051332', 10, 'n'],
];

export function buildN43File(opts: {
  movements: N43Movement[];
  initialCents?: number;
  start?: string;
  end?: string;
  /** Saldo final distinto del que sale (para probar el aviso de que no cuadra). */
  finalCents?: number;
}): string {
  const initial = opts.initialCents ?? 100000;
  const lines: string[] = [
    n43Record([
      ['11', 2],
      ...ACCOUNT,
      [opts.start ?? '260601', 6],
      [opts.end ?? '260630', 6],
      [initial < 0 ? '1' : '2', 1],
      [Math.abs(initial), 14, 'n'],
      ['978', 3],
      ['3', 1],
      ['PRUEBAS', 26],
      ['', 3],
    ]),
  ];
  for (const m of opts.movements) {
    lines.push(
      n43Record([
        ['22', 2],
        ['', 4],
        ['0418', 4, 'n'],
        [m.date ?? '260615', 6],
        [m.valueDate ?? m.date ?? '260615', 6],
        [m.common ?? (m.amountCents < 0 ? '14' : '04'), 2],
        [m.own ?? '000', 3],
        [m.amountCents < 0 ? '1' : '2', 1],
        [Math.abs(m.amountCents), 14, 'n'],
        [m.documentNumber ?? 0, 10, 'n'],
        [m.reference1 ?? '', 12],
        [m.reference2 ?? '', 16],
      ]),
    );
    if (m.concept) {
      lines.push(
        n43Record([
          ['23', 2],
          ['01', 2],
          [m.concept.slice(0, 38), 38],
          [m.concept.slice(38, 76), 38],
        ]),
      );
    }
  }
  const debits = opts.movements.filter((m) => m.amountCents < 0);
  const credits = opts.movements.filter((m) => m.amountCents >= 0);
  const final = opts.finalCents ?? initial + opts.movements.reduce((s, m) => s + m.amountCents, 0);
  lines.push(
    n43Record([
      ['33', 2],
      ...ACCOUNT,
      [debits.length, 5, 'n'],
      [-debits.reduce((s, m) => s + m.amountCents, 0), 14, 'n'],
      [credits.length, 5, 'n'],
      [credits.reduce((s, m) => s + m.amountCents, 0), 14, 'n'],
      [final < 0 ? '1' : '2', 1],
      [Math.abs(final), 14, 'n'],
      ['978', 3],
      ['', 4],
    ]),
  );
  lines.push(
    n43Record([
      ['88', 2],
      ['999999999999999999', 18],
      [lines.length, 6, 'n'],
      ['', 54],
    ]),
  );
  return lines.join('\n');
}

/** AAMMDD de hace `daysAgo` días (el cobro se fecha con el día del apunte). */
export function n43Date(daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(2, 10).replace(/-/g, '');
}

/**
 * Extracto con un abono (ayer, `reference` en la referencia 2) y un cargo
 * (hoy). Los importes van como en el fichero: 14 cifras con 2 decimales.
 * Cada llamada lleva un número de documento distinto: dos importaciones de una
 * prueba no se toman por el mismo extracto.
 */
export function buildN43(
  creditAmount: string,
  reference: string,
  debitAmount = '00000000005000',
): string {
  const doc = randomInt(1, 2 ** 31 - 1);
  return buildN43File({
    start: n43Date(30),
    end: n43Date(0),
    movements: [
      {
        amountCents: Number(creditAmount),
        date: n43Date(1),
        reference2: reference,
        // La referencia 2 tiene 16 caracteres: si no cabe, va también en el concepto.
        ...(reference.length > 16 ? { concept: reference } : {}),
        documentNumber: doc,
      },
      {
        amountCents: -Number(debitAmount),
        date: n43Date(0),
        documentNumber: doc + 1,
      },
    ],
  });
}
