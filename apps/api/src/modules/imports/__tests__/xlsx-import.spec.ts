import ExcelJS from 'exceljs';

import { parseRaw, resolveImportCsv, xlsxBase64ToCsv } from '../import-engine';

/** Construye un XLSX en base64 con la cabecera + filas dadas (primera hoja). */
async function makeXlsxBase64(rows: (string | number)[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Datos');
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

describe('xlsxBase64ToCsv', () => {
  it('convierte la primera hoja a CSV (cabecera + filas) parseable por parseRaw', async () => {
    const base64 = await makeXlsxBase64([
      ['customerType', 'firstName', 'lastName', 'email'],
      ['individual', 'Ana', 'García', 'ana@x.local'],
      ['individual', 'Bob', 'Smith', 'bob@x.local'],
    ]);

    const csv = await xlsxBase64ToCsv(base64);
    const { columns, records } = parseRaw(csv);

    expect(columns).toEqual(['customerType', 'firstName', 'lastName', 'email']);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ firstName: 'Ana', email: 'ana@x.local' });
    expect(records[1]).toMatchObject({ firstName: 'Bob', lastName: 'Smith' });
  });

  it('escapa valores con comas/comillas y salta filas vacías', async () => {
    const base64 = await makeXlsxBase64([
      ['name', 'note'],
      ['Uno', 'a, b "c"'],
      ['', ''], // fila vacía → se salta
      ['Dos', 'sin comas'],
    ]);

    const csv = await xlsxBase64ToCsv(base64);
    const { records } = parseRaw(csv);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ name: 'Uno', note: 'a, b "c"' });
    expect(records[1]).toMatchObject({ name: 'Dos' });
  });

  it('convierte números a texto (los importadores normalizan luego)', async () => {
    const base64 = await makeXlsxBase64([
      ['code', 'price'],
      ['A-1', 49.5],
    ]);
    const csv = await xlsxBase64ToCsv(base64);
    const { records } = parseRaw(csv);
    expect(records[0]).toMatchObject({ code: 'A-1', price: '49.5' });
  });

  it('resolveImportCsv: csv → passthrough; xlsx → convierte', async () => {
    const csv = 'a,b\n1,2';
    expect(await resolveImportCsv(csv, 'csv')).toBe(csv);

    const base64 = await makeXlsxBase64([
      ['a', 'b'],
      ['1', '2'],
    ]);
    const converted = await resolveImportCsv(base64, 'xlsx');
    expect(parseRaw(converted).records[0]).toMatchObject({ a: '1', b: '2' });
  });
});
