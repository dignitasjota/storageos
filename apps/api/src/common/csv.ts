/**
 * Celdas de los CSV que se abren en Excel (separador `;`, coma decimal).
 *
 * Un texto que empieza por `=`, `+`, `-`, `@`, tabulador o retorno de carro
 * Excel lo toma por una fórmula: alguien podría escribir
 * `=HYPERLINK("http://…")` en un formulario y, al abrir la exportación, se
 * ejecutaría. Esos textos salen con un apóstrofo delante (lo recomendado por
 * OWASP). Los números (también los negativos, `-12,50`) se dejan tal cual.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+([.,]\d+)*$/;

/** El texto sin el riesgo de fórmula (sin comillas ni escape del CSV). */
export function neutralizeCsvText(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

/** Una celda: los números con coma decimal; el texto neutralizado y entre comillas si hace falta. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value).replace('.', ',');
  const text = neutralizeCsvText(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Igual que `csvCell`, con los saltos de línea cambiados por espacios (una fila por registro). */
export function csvLineCell(value: string | null | undefined): string {
  return csvCell((value ?? '').replace(/\r?\n/g, ' '));
}

/** BOM (U+FEFF) para que Excel lea el UTF-8; con charCode por el lint `no-irregular-whitespace`. */
export const CSV_BOM = String.fromCharCode(0xfeff);
