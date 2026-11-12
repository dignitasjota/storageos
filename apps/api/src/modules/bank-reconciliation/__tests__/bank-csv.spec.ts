import { parseBankCsv, parseCsvAmount, parseCsvDate } from '../bank-csv';

const BBVA = `Movimientos de la cuenta;;;;
Cuenta;ES91 2100 0418 4502 0005 1332;;;
;;;;
F.Valor;Fecha;Concepto;Movimiento;Importe;Saldo
06/11/2026;06/11/2026;TRANSFERENCIA DE GARCIA LOPEZ JOSE;Transferencia recibida;121,00;1.371,00
05/11/2026;05/11/2026;RECIBO IBERDROLA;Adeudo;-50,00;1.250,00
04/11/2026;04/11/2026;BIZUM DE ANA PEREZ;Bizum;1.200,00;1.300,00
`;

const CAIXA = `Fecha,Fecha valor,Descripción,Cargo,Abono,Saldo
2026-11-04,2026-11-04,"TRANSF. ANA, S.L.",,"60,50","160,50"
2026-11-05,2026-11-05,COMISION MANTENIMIENTO,"10,00",,"150,50"
`;

describe('CSV de movimientos de la banca online', () => {
  it('importes y fechas en formato español', () => {
    expect(parseCsvAmount('1.234,56')).toBe(123456);
    expect(parseCsvAmount('-45,00')).toBe(-4500);
    expect(parseCsvAmount('(12,30)')).toBe(-1230);
    expect(parseCsvAmount('1,234.56')).toBe(123456);
    expect(parseCsvAmount('45.00 €')).toBe(4500);
    expect(parseCsvAmount('1.234')).toBe(123400);
    expect(parseCsvAmount('abc')).toBeNull();
    expect(parseCsvDate('05/11/2026')).toBe('2026-11-05');
    expect(parseCsvDate('5-11-26')).toBe('2026-11-05');
    expect(parseCsvDate('2026-11-05 10:30')).toBe('2026-11-05');
    expect(parseCsvDate('31/02/2026')).toBeNull();
  });

  it('reconoce las columnas por su título, ordena del más antiguo y comprueba los saldos', () => {
    const r = parseBankCsv(BBVA);
    expect(r.headers).toEqual(['F.Valor', 'Fecha', 'Concepto', 'Movimiento', 'Importe', 'Saldo']);
    expect(r.mapping).toEqual(
      expect.objectContaining({ valueDate: 0, date: 1, description: 2, amount: 4, balance: 5 }),
    );
    const a = r.account!;
    expect(a.accountLabel).toBe('IBAN ····1332');
    expect(a.startDate).toBe('2026-11-04');
    expect(a.endDate).toBe('2026-11-06');
    expect(a.transactions.map((t) => t.amount)).toEqual([120000, -5000, 12100]);
    expect(a.transactions[2]!.description).toBe('TRANSFERENCIA DE GARCIA LOPEZ JOSE');
    expect(a.initialBalance).toBe(10000);
    expect(a.finalBalance).toBe(137100);
    expect(a.balancesKnown).toBe(true);
    expect(a.warnings).toEqual([]);
  });

  it('cargos y abonos en dos columnas, comillas y sin IBAN', () => {
    const r = parseBankCsv(CAIXA);
    expect(r.mapping).toEqual(
      expect.objectContaining({ date: 0, valueDate: 1, description: 2, debit: 3, credit: 4 }),
    );
    expect(r.account!.transactions.map((t) => [t.amount, t.description])).toEqual([
      [6050, 'TRANSF. ANA, S.L.'],
      [-1000, 'COMISION MANTENIMIENTO'],
    ]);
    expect(r.account!.accountLabel).toBe('');
  });

  it('columnas que no reconoce: se eligen a mano', () => {
    const csv = 'Dia;Texto;Euros\n05/11/2026;PAGO;10,00\n';
    const auto = parseBankCsv(csv);
    expect(auto.mapping).toBeNull();
    expect(auto.headers).toEqual(['Dia', 'Texto', 'Euros']);
    const manual = parseBankCsv(csv, { date: 0, description: 1, amount: 2 });
    expect(manual.account!.transactions).toEqual([
      expect.objectContaining({ operationDate: '2026-11-05', amount: 1000, description: 'PAGO' }),
    ]);
    // Sin columna de saldo no hay nada que comprobar: no es que no cuadre.
    expect(manual.account!.warnings).toEqual([]);
    expect(manual.account!.balancesKnown).toBe(false);
  });
});
