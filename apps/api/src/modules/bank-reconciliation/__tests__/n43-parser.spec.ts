import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseN43, parseN43File } from '../n43-parser';

/**
 * El extracto de muestra (`fixtures/extracto-noviembre.n43`) está generado
 * campo a campo con la tabla de la norma AEB (Cuaderno 43), no con las
 * posiciones del parser: si el parser se desplaza, esta prueba lo detecta.
 */
const fixture = readFileSync(join(__dirname, 'fixtures', 'extracto-noviembre.n43'), 'latin1');

/** Registro de 80 caracteres a partir de sus campos [valor, ancho, numérico]. */
function rec(fields: [string | number, number, 'n'?][]): string {
  return fields
    .map(([v, n, kind]) =>
      kind === 'n' ? String(v).padStart(n, '0').slice(-n) : String(v).padEnd(n, ' ').slice(0, n),
    )
    .join('');
}

const header = rec([
  ['11', 2],
  ['2100', 4],
  ['0418', 4],
  ['0200051332', 10],
  ['261101', 6],
  ['261130', 6],
  ['2', 1],
  [100000, 14, 'n'],
  ['978', 3],
  ['3', 1],
  ['', 26],
  ['', 3],
]);
function movement(dh: '1' | '2', cents: number, date = '261103'): string {
  return rec([
    ['22', 2],
    ['', 4],
    ['0418', 4],
    [date, 6],
    [date, 6],
    ['04', 2],
    ['000', 3],
    [dh, 1],
    [cents, 14, 'n'],
    [0, 10, 'n'],
    ['', 12],
    ['', 16],
  ]);
}
function footer(final: number, debit: [number, number], credit: [number, number]): string {
  return rec([
    ['33', 2],
    ['2100', 4],
    ['0418', 4],
    ['0200051332', 10],
    [debit[0], 5, 'n'],
    [debit[1], 14, 'n'],
    [credit[0], 5, 'n'],
    [credit[1], 14, 'n'],
    ['2', 1],
    [final, 14, 'n'],
    ['978', 3],
    ['', 4],
  ]);
}
const eof = (count: number) =>
  rec([
    ['88', 2],
    ['9'.repeat(18), 18],
    [count, 6, 'n'],
    ['', 54],
  ]);

describe('parseN43', () => {
  it('lee el extracto de muestra con el trazado oficial', () => {
    const { accounts, warnings } = parseN43File(fixture);
    expect(warnings).toEqual([]);
    expect(accounts).toHaveLength(1);
    const acc = accounts[0]!;
    expect(acc.accountLabel).toBe('2100 0418 0200051332');
    expect(acc.currency).toBe('EUR');
    expect(acc.startDate).toBe('2026-11-01');
    expect(acc.endDate).toBe('2026-11-30');
    expect(acc.initialBalance).toBe(250000);
    expect(acc.finalBalance).toBe(400050);
    expect(acc.warnings).toEqual([]);
    expect(acc.transactions).toHaveLength(4);

    const [transfer, remittance, returned, fee] = acc.transactions;
    expect(transfer).toMatchObject({
      operationDate: '2026-11-03',
      valueDate: '2026-11-03',
      amount: 12100,
      conceptCommon: '04',
      conceptOwn: '010',
      reference2: 'FA-2026-00042',
      description: 'TRANSFERENCIA DE JOSE MUNOZ GARCIA CONCEPTO FA-2026-00042',
    });
    expect(remittance).toMatchObject({
      operationDate: '2026-11-05',
      valueDate: '2026-11-06',
      amount: 145200,
      conceptCommon: '06',
      reference1: 'REM-2026-11',
    });
    expect(returned).toMatchObject({ amount: -6050, conceptCommon: '14' });
    expect(returned!.description).toContain('DEVOLUCION RECIBO SEPA');
    expect(fee).toMatchObject({ amount: -1200, operationDate: '2026-11-30' });
  });

  it('avisa si el saldo inicial más los movimientos no da el saldo final', () => {
    const file = [header, movement('2', 12100), footer(999999, [0, 0], [1, 12100]), eof(3)].join(
      '\n',
    );
    const acc = parseN43File(file).accounts[0]!;
    expect(acc.warnings.join(' ')).toContain('El saldo no cuadra');
  });

  it('avisa si los totales del banco no coinciden con los movimientos leídos', () => {
    const file = [header, movement('2', 12100), footer(112100, [0, 0], [2, 24200]), eof(3)].join(
      '\n',
    );
    const acc = parseN43File(file).accounts[0]!;
    expect(acc.warnings.join(' ')).toContain('Los totales del banco');
  });

  it('avisa de un fichero cortado (sin final de cuenta ni fin de fichero)', () => {
    const { accounts, warnings } = parseN43File([header, movement('1', 5000)].join('\n'));
    expect(accounts[0]!.warnings.join(' ')).toContain('registro 33');
    expect(accounts[0]!.finalBalance).toBe(95000);
    expect(warnings.join(' ')).toContain('registro de fin (88)');
  });

  it('no da por buena una fecha imposible', () => {
    const file = [
      header,
      movement('2', 100, '260231'),
      footer(100100, [0, 0], [1, 100]),
      eof(3),
    ].join('\n');
    expect(parseN43(file)[0]!.transactions[0]!.operationDate).toBeNull();
  });

  it('tolera ficheros vacíos y movimientos sin cabecera', () => {
    expect(parseN43('')).toEqual([]);
    const orphan = parseN43File(movement('2', 100));
    expect(orphan.accounts).toEqual([]);
    expect(orphan.warnings.join(' ')).toContain('sin cabecera');
  });
});
