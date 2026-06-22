import { parseN43 } from '../n43-parser';

/** Construye una línea N43 de 80 chars a partir de tramos [pos1, texto]. */
function line(segments: [number, string][]): string {
  const buf = ' '.repeat(80).split('');
  for (const [pos, text] of segments) {
    for (let i = 0; i < text.length; i++) buf[pos - 1 + i] = text[i]!;
  }
  return buf.join('');
}

describe('parseN43', () => {
  // Cabecera: entidad 2100, oficina 0418, cuenta 0200051332, fechas 260601-260630,
  // saldo inicial haber 1000.00 €, divisa 978 (EUR).
  const header = line([
    [1, '11'],
    [3, '2100'],
    [7, '0418'],
    [11, '0200051332'],
    [21, '260601'],
    [27, '260630'],
    [33, '2'],
    [34, '00000000100000'],
    [48, '978'],
  ]);
  // Movimiento abono (haber=2) 121.00 € el 2026-06-15.
  const credit = line([
    [1, '22'],
    [7, '260615'],
    [13, '260615'],
    [19, '12'],
    [21, '001'],
    [24, '2'],
    [25, '00000000012100'],
    [39, '0000000001'],
    [49, 'REM-ABC'],
    [61, 'FA-2026-0001'],
  ]);
  // Concepto complementario.
  const concept = line([
    [1, '23'],
    [3, '01'],
    [5, 'TRANSFERENCIA SEPA'],
  ]);
  // Movimiento cargo (debe=1) 50.00 €.
  const debit = line([
    [1, '22'],
    [7, '260616'],
    [13, '260616'],
    [24, '1'],
    [25, '00000000005000'],
  ]);
  // Final de cuenta: saldo final haber 1071.00 €.
  const footer = line([
    [1, '33'],
    [49, '2'],
    [50, '00000000107100'],
  ]);
  const eof = line([[1, '88']]);

  const file = [header, credit, concept, debit, footer, eof].join('\n');

  it('parsea cuenta, fechas, saldos y movimientos con signo', () => {
    const accounts = parseN43(file);
    expect(accounts).toHaveLength(1);
    const acc = accounts[0]!;
    expect(acc.accountLabel).toBe('2100 0418 0200051332');
    expect(acc.currency).toBe('EUR');
    expect(acc.startDate).toBe('2026-06-01');
    expect(acc.endDate).toBe('2026-06-30');
    expect(acc.initialBalance).toBe(100000);
    expect(acc.finalBalance).toBe(107100);
    expect(acc.transactions).toHaveLength(2);

    const [c, d] = acc.transactions;
    expect(c!.amount).toBe(12100); // abono +
    expect(c!.operationDate).toBe('2026-06-15');
    expect(c!.reference2).toBe('FA-2026-0001');
    expect(c!.description).toContain('TRANSFERENCIA SEPA');
    expect(d!.amount).toBe(-5000); // cargo −
  });

  it('tolera líneas cortas y ficheros vacíos', () => {
    expect(parseN43('')).toEqual([]);
    expect(parseN43('22\n')).toEqual([]); // 22 sin cabecera previa se ignora
  });
});
