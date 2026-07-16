import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

import type { ReportResult } from '../generators/types';

@Injectable()
export class XlsxRenderer {
  async render(result: ReportResult): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TrasterOS';
    wb.created = result.generatedAt;
    const sheet = wb.addWorksheet(result.title.slice(0, 31));

    // Titulo
    sheet.addRow([result.title]).font = { size: 14, bold: true };
    if (result.subtitle)
      sheet.addRow([result.subtitle]).font = { italic: true, color: { argb: 'FF666666' } };
    sheet.addRow([]);

    // Columnas
    const headerRow = sheet.addRow(result.columns.map((c) => c.label));
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
    });
    result.columns.forEach((c, i) => {
      const col = sheet.getColumn(i + 1);
      if (c.width) col.width = c.width;
      if (c.align) col.alignment = { horizontal: c.align };
    });

    // Filas
    for (const row of result.rows) {
      const values = result.columns.map((c) => {
        const v = row[c.key];
        if (v == null) return '';
        if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
          return new Date(`${v}T00:00:00.000Z`);
        }
        return v;
      });
      const r = sheet.addRow(values);
      result.columns.forEach((c, i) => {
        const cell = r.getCell(i + 1);
        if (c.type === 'currency') cell.numFmt = '#,##0.00 €';
        if (c.type === 'number') cell.numFmt = '#,##0';
        if (c.type === 'date') cell.numFmt = 'yyyy-mm-dd';
      });
    }

    // Resumen
    if (result.summary?.length) {
      sheet.addRow([]);
      const titleRow = sheet.addRow(['Resumen']);
      titleRow.font = { bold: true, size: 12 };
      for (const s of result.summary) {
        sheet.addRow([s.label, s.value]);
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }
}
