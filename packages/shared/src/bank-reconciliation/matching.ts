/**
 * Ayudas puras para conciliar un movimiento del banco: el texto del apunte en
 * mayúsculas y sin acentos, si lleva el nombre de un inquilino, qué parte del
 * concepto identifica al ordenante (para recordarlo como regla) y qué facturas
 * de un inquilino suman justo el importe.
 */

/** Palabras del banco que no identifican a nadie. */
const NOISE = new Set([
  'A',
  'ABONO',
  'ADEUDO',
  'ALQUILER',
  'BENEFICIARIO',
  'BIZUM',
  'CARGO',
  'COMPRA',
  'CON',
  'CONCEPTO',
  'CTA',
  'CUENTA',
  'CUOTA',
  'DE',
  'DEL',
  'DEVOLUCION',
  'DIVISA',
  'DOMICILIACION',
  'DOMICILIADO',
  'EL',
  'EMITIDA',
  'EN',
  'ENTIDADES',
  'ENVIO',
  'EUR',
  'EURO',
  'EUROS',
  'FACTURA',
  'FAVOR',
  'FRA',
  'INGRESO',
  'INMED',
  'INMEDIATA',
  'LA',
  'LAS',
  'LOS',
  'MES',
  'N',
  'NOMINA',
  'NUM',
  'ORDENANTE',
  'OTRAS',
  'PAGO',
  'PARA',
  'POR',
  'RECEP',
  'RECIBIDA',
  'RECIBO',
  'REF',
  'REFERENCIA',
  'SEPA',
  'TARJETA',
  'TRANS',
  'TRANSF',
  'TRANSFER',
  'TRANSFERENCIA',
  'TRASTERO',
  'TRF',
  'Y',
]);

/** Formas jurídicas: no cuentan al buscar el nombre de una empresa. */
const LEGAL_FORMS = new Set(['SL', 'SLU', 'SA', 'SAU', 'SC', 'CB', 'SLL', 'SCOOP', 'COOP']);

/** Mayúsculas, sin acentos ni signos, con un espacio entre palabras. */
export function normalizeBankText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** ¿El texto del apunte lleva el patrón como palabras enteras? */
export function bankTextContains(text: string, pattern: string): boolean {
  const p = normalizeBankText(pattern);
  if (p.length < 3) return false;
  return ` ${normalizeBankText(text)} `.includes(` ${p} `);
}

/**
 * ¿El apunte lleva el nombre del inquilino? Todas las palabras de su nombre
 * (al menos dos, o una de cinco letras o más), en cualquier orden: el banco
 * suele poner primero los apellidos.
 */
export function nameMatches(text: string, name: string): boolean {
  const words = normalizeBankText(name)
    .split(' ')
    .filter((w) => w.length >= 3 && !LEGAL_FORMS.has(w) && !/\d/.test(w));
  if (words.length === 0) return false;
  if (words.length === 1 && words[0]!.length < 5) return false;
  const have = new Set(normalizeBankText(text).split(' '));
  return words.every((w) => have.has(w));
}

/**
 * Lo que identifica al ordenante en el concepto, para recordarlo: la primera
 * serie de dos a cuatro palabras que no son del banco ni llevan cifras; si no
 * hay, la palabra más larga.
 */
export function guessPayerPattern(text: string): string {
  const words = normalizeBankText(text).split(' ').filter(Boolean);
  let run: string[] = [];
  for (const w of words) {
    if (w.length >= 2 && !/\d/.test(w) && !NOISE.has(w)) {
      run.push(w);
      if (run.length === 4) break;
    } else if (run.length >= 2) {
      break;
    } else {
      run = [];
    }
  }
  if (run.length >= 2) return run.join(' ');
  const single = words
    .filter((w) => w.length >= 4 && !/\d/.test(w) && !NOISE.has(w))
    .sort((a, b) => b.length - a.length)[0];
  return single ?? '';
}

/**
 * Facturas (en el orden dado, la más antigua primero) que suman justo el
 * importe: dos o más, como mucho `maxItems`. null si ninguna combinación cuadra.
 */
export function findInvoiceSubset(
  invoices: { id: string; cents: number }[],
  targetCents: number,
  maxItems = 6,
): string[] | null {
  const list = invoices.filter((i) => i.cents > 0).slice(0, 15);
  const pick: string[] = [];
  const walk = (start: number, left: number): boolean => {
    if (left === 0) return pick.length >= 2;
    if (pick.length === maxItems) return false;
    for (let k = start; k < list.length; k++) {
      const inv = list[k]!;
      if (inv.cents > left) continue;
      pick.push(inv.id);
      if (walk(k + 1, left - inv.cents)) return true;
      pick.pop();
    }
    return false;
  };
  return walk(0, targetCents) ? [...pick] : null;
}
