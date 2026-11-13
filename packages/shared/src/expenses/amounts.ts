/**
 * Desglose fiscal de un gasto. Lo que cuesta (`amount`) es la base más el IVA
 * que no se deduce; lo que se paga al proveedor (`totalAmount`) es la base más
 * el IVA menos la retención (que se ingresa en Hacienda con el 111 o el 115).
 * Sin base, el gasto queda «sin desglosar»: solo su importe.
 */

export interface ExpenseAmountsInput {
  /** Importe sin desglosar (se usa si no hay base). */
  amount?: number | null | undefined;
  baseAmount?: number | null | undefined;
  vatRate?: number | null | undefined;
  /** false = el IVA no se deduce y cuenta como gasto. Por defecto, sí se deduce. */
  vatDeductible?: boolean | null | undefined;
  withholdingRate?: number | null | undefined;
}

export interface ExpenseAmounts {
  /** true = con base, IVA y retención. */
  broken: boolean;
  /** Lo que cuesta: base + IVA no deducible (o el importe sin desglosar). */
  amount: number;
  baseAmount: number | null;
  vatAmount: number | null;
  withholdingAmount: number | null;
  /** Lo que se paga al proveedor. */
  totalAmount: number;
}

const cents = (n: number): number => Math.round(n * 100);

/** Importe × porcentaje redondeado al céntimo (mitades hacia arriba en valor absoluto). */
function pct(baseCents: number, rate: number): number {
  const raw = (baseCents * rate) / 100;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

export function expenseAmounts(input: ExpenseAmountsInput): ExpenseAmounts {
  if (input.baseAmount === null || input.baseAmount === undefined) {
    const amount = cents(input.amount ?? 0) / 100;
    return {
      broken: false,
      amount,
      baseAmount: null,
      vatAmount: null,
      withholdingAmount: null,
      totalAmount: amount,
    };
  }
  const base = cents(input.baseAmount);
  const vat = pct(base, input.vatRate ?? 0);
  const withholding = pct(base, input.withholdingRate ?? 0);
  const deductible = input.vatDeductible !== false;
  return {
    broken: true,
    amount: (base + (deductible ? 0 : vat)) / 100,
    baseAmount: base / 100,
    vatAmount: vat / 100,
    withholdingAmount: withholding / 100,
    totalAmount: (base + vat - withholding) / 100,
  };
}

/**
 * Base a partir del total de la factura (lo que se paga), para quien solo
 * tiene el total: total = base × (1 + IVA − retención).
 */
export function expenseBaseFromTotal(
  total: number,
  vatRate: number | null | undefined,
  withholdingRate: number | null | undefined,
): number {
  const factor = 1 + (vatRate ?? 0) / 100 - (withholdingRate ?? 0) / 100;
  if (factor <= 0) return 0;
  return Math.round((total / factor) * 100) / 100;
}
