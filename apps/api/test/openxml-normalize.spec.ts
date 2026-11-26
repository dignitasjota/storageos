import ExcelJS from 'exceljs';

import { xlsxBase64ToCsv, xlsxSheets } from '../src/modules/imports/import-engine';
import { normalizeOpenXmlPackage } from '../src/modules/imports/openxml-normalize';

import { buildOpenXmlWorkbook } from './helpers/openxml-workbook';

const toArrayBuffer = (b: Buffer) =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('Excel del OpenXML SDK (prefijo x: y destinos absolutos)', () => {
  const sheets = [
    {
      name: 'Resumen',
      rows: [
        ['INDICADOR', 'VALOR'],
        ['Dominio', 'ejemplo.es'],
      ],
    },
    {
      name: 'Datos',
      rows: [
        ['keyword', 'volumen', 'cpc'],
        ['trasteros mislata', 20, 3.1],
        ['vacía', null, 0],
      ],
    },
  ];

  it('exceljs no lo abre tal cual', async () => {
    const buffer = await buildOpenXmlWorkbook(sheets);
    const wb = new ExcelJS.Workbook();
    await expect(wb.xlsx.load(toArrayBuffer(buffer))).rejects.toThrow();
  });

  it('normalizado se lee entero, con todas las hojas y celdas (vacía ≠ 0)', async () => {
    const buffer = await buildOpenXmlWorkbook(sheets);
    const read = await xlsxSheets(buffer);
    expect(read.map((s) => s.name)).toEqual(['Resumen', 'Datos']);
    expect(read[0]!.rows).toEqual([
      ['INDICADOR', 'VALOR'],
      ['Dominio', 'ejemplo.es'],
    ]);
    expect(read[1]!.rows).toEqual([
      ['keyword', 'volumen', 'cpc'],
      ['trasteros mislata', '20', '3.1'],
      ['vacía', '', '0'],
    ]);
  });

  it('también por la conversión a CSV de las importaciones generales', async () => {
    const buffer = await buildOpenXmlWorkbook([sheets[1]!]);
    const csv = await xlsxBase64ToCsv(buffer.toString('base64'));
    expect(csv.split(/\r?\n/)[1]).toBe('trasteros mislata,20,3.1');
  });

  it('un Excel normal no se toca', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Hoja').addRow(['a', 1]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await normalizeOpenXmlPackage(buffer)).toBeNull();
    expect((await xlsxSheets(buffer))[0]!.rows).toEqual([['a', '1']]);
  });
});
