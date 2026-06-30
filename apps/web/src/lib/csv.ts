/**
 * Descarga `rows` como un CSV con separador `;` y BOM UTF-8 (para que Excel en
 * español lo abra bien). La primera fila suele ser la cabecera.
 */
export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(';')).join('\n');
  // BOM (U+FEFF) para que Excel detecte UTF-8.
  const blob = new Blob([String.fromCharCode(0xfeff) + csv], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
