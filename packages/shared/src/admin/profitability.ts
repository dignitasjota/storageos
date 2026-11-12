import { z } from 'zod';

/**
 * Calculadora de rentabilidad de un local de trasteros (web de TrasterOS,
 * `/calculadora-rentabilidad-trasteros`). Puro: lo usan la página (resultados
 * al momento) y el API (el informe que se manda por correo se recalcula en el
 * servidor, no se fía del navegador). Todo sin IVA y al mes.
 */
export const ProfitabilityInputSchema = z.object({
  /** Número de trasteros del local. */
  units: z.number().int().min(1).max(5000),
  /** Precio medio de un trastero al mes, sin IVA. */
  avgPrice: z.number().min(1).max(5000),
  /** Ocupación media prevista, en %. */
  occupancyPct: z.number().min(0).max(100),
  /** Alquiler o hipoteca del local al mes. */
  rent: z.number().min(0).max(1_000_000),
  /** Luz, agua, internet, alarma… al mes. */
  utilities: z.number().min(0).max(1_000_000),
  /** Personal y limpieza al mes. */
  staff: z.number().min(0).max(1_000_000),
  /** Seguros, mantenimiento, software y otros gastos al mes. */
  other: z.number().min(0).max(1_000_000),
  /** Inversión inicial (obra, puertas, accesos…), para calcular cuándo se recupera; 0 = no se calcula. */
  investment: z.number().min(0).max(100_000_000).default(0),
});
export type ProfitabilityInput = z.infer<typeof ProfitabilityInputSchema>;

export interface ProfitabilityResult {
  /** Trasteros alquilados de media (con decimales). */
  rentedUnits: number;
  monthlyRevenue: number;
  monthlyCosts: number;
  monthlyProfit: number;
  yearlyRevenue: number;
  yearlyProfit: number;
  /** Margen sobre ingresos, en %; null sin ingresos. */
  marginPct: number | null;
  /** Ocupación con la que se cubren los gastos, en %; null si ni llenos los cubre. */
  breakEvenOccupancyPct: number | null;
  /** Trasteros alquilados con los que se cubren los gastos (redondeado hacia arriba). */
  breakEvenUnits: number | null;
  /** Meses para recuperar la inversión; null sin inversión o sin beneficio. */
  paybackMonths: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeProfitability(input: ProfitabilityInput): ProfitabilityResult {
  const rentedUnits = input.units * (input.occupancyPct / 100);
  const monthlyRevenue = rentedUnits * input.avgPrice;
  const monthlyCosts = input.rent + input.utilities + input.staff + input.other;
  const monthlyProfit = monthlyRevenue - monthlyCosts;
  const fullRevenue = input.units * input.avgPrice;
  const breakEvenUnits =
    input.avgPrice > 0 && monthlyCosts <= fullRevenue
      ? Math.ceil(monthlyCosts / input.avgPrice)
      : null;
  const breakEvenOccupancyPct =
    fullRevenue > 0 && monthlyCosts <= fullRevenue
      ? Math.round((monthlyCosts / fullRevenue) * 1000) / 10
      : null;
  return {
    rentedUnits: Math.round(rentedUnits * 10) / 10,
    monthlyRevenue: round2(monthlyRevenue),
    monthlyCosts: round2(monthlyCosts),
    monthlyProfit: round2(monthlyProfit),
    yearlyRevenue: round2(monthlyRevenue * 12),
    yearlyProfit: round2(monthlyProfit * 12),
    marginPct: monthlyRevenue > 0 ? Math.round((monthlyProfit / monthlyRevenue) * 1000) / 10 : null,
    breakEvenOccupancyPct,
    breakEvenUnits,
    paybackMonths:
      input.investment > 0 && monthlyProfit > 0
        ? Math.ceil(input.investment / monthlyProfit)
        : null,
  };
}

/** Valores de ejemplo con los que se abre la calculadora. */
export const DEFAULT_PROFITABILITY_INPUT: ProfitabilityInput = {
  units: 100,
  avgPrice: 60,
  occupancyPct: 80,
  rent: 2500,
  utilities: 300,
  staff: 600,
  other: 400,
  investment: 60000,
};
