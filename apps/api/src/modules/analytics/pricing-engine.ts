/**
 * Motor de precio sugerido (funciones puras, sin BD).
 *
 * Precio objetivo = precio de mercado del tamaño exacto × posicionamiento del
 * local × ajuste por demanda. Después se aplican los límites: cambio máximo
 * por vez (la mitad si hay pocos datos), precio mínimo/máximo del tipo y espera
 * mínima entre cambios.
 */

export type PricingConfidence = 'high' | 'medium' | 'low';

const DAY_MS = 86_400_000;
/** A los 60 días un dato de la competencia pesa la mitad; a partir de 180 no cuenta. */
const FRESHNESS_HALF_LIFE_DAYS = 60;
const FRESHNESS_CUTOFF_DAYS = 180;
/** Exponente de la curva precio-tamaño: el precio crece menos que los m². */
const MIN_EXPONENT = 0.3;
const MAX_EXPONENT = 1.1;
/** Peso de la ocupación del local al suavizar la de un tamaño con pocos trasteros. */
const OCCUPANCY_PRIOR_UNITS = 3;
/** Por debajo de este cambio no merece la pena tocar el precio. */
export const MIN_CHANGE_PCT = 2;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

/**
 * Peso de un dato de la competencia para un local concreto: antigüedad ×
 * cercanía. Un competidor ligado al local pesa 1; con distancia, cae con los
 * km (a 3 km pesa la mitad); de la misma zona 0,6; el resto 0,3.
 */
export function observationWeight(args: {
  ageDays: number;
  linkedToFacility: boolean;
  distanceKm: number | null;
  sameZone: boolean;
}): number {
  if (args.ageDays > FRESHNESS_CUTOFF_DAYS) return 0;
  const freshness = 0.5 ** (args.ageDays / FRESHNESS_HALF_LIFE_DAYS);
  let proximity: number;
  if (args.linkedToFacility) proximity = 1;
  else if (args.distanceKm != null) proximity = 1 / (1 + args.distanceKm / 3);
  else if (args.sameZone) proximity = 0.6;
  else proximity = 0.3;
  return freshness * proximity;
}

export interface MarketObservation {
  areaM2: number;
  /** Precio mensual comparable (sin IVA, con el seguro obligatorio incluido). */
  price: number;
  weight: number;
}

export interface MarketCurve {
  /** Precio de mercado para un tamaño. */
  priceAt(areaM2: number): number;
  /** Nº efectivo de datos (tiene en cuenta los pesos). */
  effectiveN: number;
  points: number;
  minArea: number;
  maxArea: number;
}

function weightedMedian(values: { v: number; w: number }[]): number {
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return sorted[sorted.length - 1]!.v;
}

/**
 * Ajusta la curva de precio del mercado: ln(precio) = a + b·ln(m²) por mínimos
 * cuadrados ponderados. Con menos de 3 datos o un único tamaño, usa la mediana
 * ponderada del €/m² (b = 1).
 */
export function fitMarketCurve(observations: MarketObservation[]): MarketCurve | null {
  const obs = observations.filter((o) => o.weight > 0 && o.areaM2 > 0 && o.price > 0);
  if (obs.length === 0) return null;

  const sumW = obs.reduce((s, o) => s + o.weight, 0);
  const sumW2 = obs.reduce((s, o) => s + o.weight ** 2, 0);
  const effectiveN = sumW2 > 0 ? sumW ** 2 / sumW2 : 0;
  const areas = obs.map((o) => o.areaM2);
  const minArea = Math.min(...areas);
  const maxArea = Math.max(...areas);
  const base = { effectiveN, points: obs.length, minArea, maxArea };

  const distinctSizes = new Set(areas.map((a) => Math.round(a * 10))).size;
  if (obs.length < 3 || distinctSizes < 2) {
    const perM2 = weightedMedian(obs.map((o) => ({ v: o.price / o.areaM2, w: o.weight })));
    return { ...base, priceAt: (area) => perM2 * area };
  }

  const xs = obs.map((o) => Math.log(o.areaM2));
  const ys = obs.map((o) => Math.log(o.price));
  const meanX = obs.reduce((s, o, i) => s + o.weight * xs[i]!, 0) / sumW;
  const meanY = obs.reduce((s, o, i) => s + o.weight * ys[i]!, 0) / sumW;
  let cov = 0;
  let varX = 0;
  obs.forEach((o, i) => {
    cov += o.weight * (xs[i]! - meanX) * (ys[i]! - meanY);
    varX += o.weight * (xs[i]! - meanX) ** 2;
  });
  const b = clamp(varX > 0 ? cov / varX : 1, MIN_EXPONENT, MAX_EXPONENT);
  const a = meanY - b * meanX;
  return { ...base, priceAt: (area) => Math.exp(a + b * Math.log(area)) };
}

/** Confianza en el precio de mercado de un tamaño. */
export function marketConfidence(curve: MarketCurve | null, areaM2: number): PricingConfidence {
  if (!curve) return 'low';
  // Muy por fuera de los tamaños que tenemos es extrapolar.
  if (areaM2 < curve.minArea / 1.5 || areaM2 > curve.maxArea * 1.5) return 'low';
  if (curve.effectiveN >= 5) return 'high';
  if (curve.effectiveN >= 2) return 'medium';
  return 'low';
}

export interface DemandFactor {
  key:
    | 'occupancy'
    | 'waitlist'
    | 'competitor_occupancy'
    | 'competitor_speed'
    | 'own_speed'
    | 'open_leads'
    | 'lost_price';
  label: string;
  detail: string;
  contribution: number;
}

/**
 * Ajuste por demanda (en %), continuo:
 * - ocupación del tamaño frente a la objetivo (suavizada con la del local si
 *   hay pocos trasteros): 10 puntos por encima = +5 %, acotado a [−10, +8];
 * - lista de espera de ese tamaño: +2 % por persona, hasta +6 %;
 * - ocupación de la competencia (solo con inventario conocido): 95 % = +3 %;
 * - lo que tarda la competencia en alquilar ese tamaño (de sus revisiones):
 *   15 días = +1 %, 30 = 0, 60 = −2 %, acotado a [−3, +3].
 */
export function demandFactors(args: {
  dimOccupied: number;
  dimTotal: number;
  facilityOccupancy: number;
  targetOccupancy: number;
  waitlist: number;
  competitorOccupancy: number | null;
  /** Mediana de días hasta alquilarse en la competencia (null sin datos suficientes). */
  competitorDaysToRent?: { medianDays: number; rentals: number } | null;
  /** Mis alquileres de este tamaño en los últimos 90 días y cuántos quedan libres. */
  ownRentals?: { rentals90: number; available: number } | null;
  /**
   * Contactos que piden este tamaño: abiertos (últimos 60 días) y perdidos por
   * precio («le pareció caro», últimos 90 días).
   */
  leads?: { open: number; lostTooExpensive: number } | null;
}): DemandFactor[] {
  const factors: DemandFactor[] = [];
  const smoothed =
    (args.dimOccupied + OCCUPANCY_PRIOR_UNITS * args.facilityOccupancy) /
    (args.dimTotal + OCCUPANCY_PRIOR_UNITS);
  const occAdj = round1(clamp((smoothed - args.targetOccupancy) * 50, -10, 8));
  if (occAdj !== 0) {
    factors.push({
      key: 'occupancy',
      label: 'Ocupación del tamaño',
      detail: `${args.dimOccupied} de ${args.dimTotal} ocupados (objetivo ${Math.round(args.targetOccupancy * 100)} %)`,
      contribution: occAdj,
    });
  }
  if (args.waitlist > 0) {
    factors.push({
      key: 'waitlist',
      label: 'Lista de espera',
      detail: `${args.waitlist} ${args.waitlist === 1 ? 'persona espera' : 'personas esperan'} este tamaño`,
      contribution: Math.min(args.waitlist * 2, 6),
    });
  }
  if (args.competitorOccupancy != null) {
    const compAdj = round1(clamp((args.competitorOccupancy - 0.85) * 30, -4, 4));
    if (compAdj !== 0) {
      factors.push({
        key: 'competitor_occupancy',
        label: 'Ocupación de la competencia',
        detail: `La competencia cercana tiene este tamaño al ${Math.round(args.competitorOccupancy * 100)} %`,
        contribution: compAdj,
      });
    }
  }
  const speed = args.competitorDaysToRent;
  if (speed) {
    const speedAdj = round1(clamp((30 - speed.medianDays) / 15, -3, 3));
    if (speedAdj !== 0) {
      factors.push({
        key: 'competitor_speed',
        label: 'Ritmo de alquiler de la competencia',
        detail: `La competencia cercana alquila este tamaño en ~${Math.round(speed.medianDays)} días (${speed.rentals} alquileres vistos)`,
        contribution: speedAdj,
      });
    }
  }
  const own = args.ownRentals;
  if (own && own.rentals90 >= MIN_OWN_RENTALS) {
    // Meses que tardaría en alquilar lo que tiene libre al ritmo actual.
    const perMonth = own.rentals90 / 3;
    const monthsOfStock = own.available / perMonth;
    const ownAdj = round1(clamp((2 - monthsOfStock) * 1.5, -3, 3));
    if (ownAdj !== 0) {
      factors.push({
        key: 'own_speed',
        label: 'Tu ritmo de alquiler',
        detail: `${own.rentals90} alquilados en 90 días y ${own.available} libres (~${round1(monthsOfStock)} meses de stock)`,
        contribution: ownAdj,
      });
    }
  }
  const leads = args.leads;
  if (leads && leads.open > 0) {
    factors.push({
      key: 'open_leads',
      label: 'Contactos interesados',
      detail: `${leads.open} ${leads.open === 1 ? 'contacto pide' : 'contactos piden'} este tamaño (últimos 60 días)`,
      contribution: Math.min(leads.open, 3),
    });
  }
  if (leads && leads.lostTooExpensive >= MIN_LOST_BY_PRICE) {
    factors.push({
      key: 'lost_price',
      label: 'Perdidos por precio',
      detail: `${leads.lostTooExpensive} contactos se perdieron porque les pareció caro (últimos 90 días)`,
      contribution: -Math.min(4, round1(leads.lostTooExpensive * 1.5)),
    });
  }
  return factors;
}

/** Mínimo de contactos perdidos por precio para restar (uno solo no es señal). */
export const MIN_LOST_BY_PRICE = 2;

/** Mínimo de alquileres propios en 90 días para usar tu ritmo de alquiler. */
export const MIN_OWN_RENTALS = 2;

/**
 * Precio mensual comparable de un trastero de la competencia: lo que paga de
 * media un cliente el primer año (sin la fianza, que se devuelve). Suma el
 * seguro obligatorio y el alta, y descuenta la promoción.
 */
export function effectiveMonthlyPrice(args: {
  price: number;
  insuranceMonthly: number;
  setupFee: number;
  promoFreeMonths: number;
  promoDiscountPct: number;
  promoDiscountMonths: number;
}): number {
  const free = clamp(args.promoFreeMonths, 0, 12);
  const discounted = clamp(args.promoDiscountMonths, 0, 12 - free);
  const pct = clamp(args.promoDiscountPct, 0, 100) / 100;
  const year =
    args.price * (12 - free) -
    args.price * pct * discounted +
    args.insuranceMonthly * 12 +
    args.setupFee;
  return Math.max(0, year / 12);
}

/**
 * Lo que vale cada característica sobre el precio (%). Un competidor con una
 * que mi local no tiene es «más caro de lo que parece» y su referencia baja.
 */
export const FEATURE_VALUE_PCT: Record<string, number> = {
  climate: 8,
  vehicle_access: 4,
  '24h': 3,
  ground_floor: 3,
  cctv: 2,
  online_booking: 1,
};

/** Multiplicador para llevar el precio de un competidor a las características de mi local. */
export function featureMultiplier(mine: string[], theirs: string[]): number {
  const a = new Set(mine);
  const b = new Set(theirs);
  let pct = 0;
  for (const [feature, value] of Object.entries(FEATURE_VALUE_PCT)) {
    if (a.has(feature) && !b.has(feature)) pct += value;
    if (b.has(feature) && !a.has(feature)) pct -= value;
  }
  return 1 + pct / 100;
}

/** Mínimo de alquileres observados para usar el ritmo de la competencia. */
export const MIN_OBSERVED_RENTALS = 3;

/**
 * Alquileres observados en el histórico de un trastero de la competencia:
 * cada paso de libre a ocupado, con los días que llevaba libre desde la
 * primera revisión en que se vio libre. Observaciones en orden cronológico.
 */
export function observedRentals(observations: { observedAt: Date; status: string }[]): number[] {
  const durations: number[] = [];
  let freeSince: Date | null = null;
  for (const o of observations) {
    if (o.status === 'available') {
      freeSince ??= o.observedAt;
    } else if (freeSince) {
      durations.push(daysBetween(freeSince, o.observedAt));
      freeSince = null;
    }
  }
  return durations;
}

/** Mediana simple. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface PriceDecision {
  targetPrice: number;
  suggestedPrice: number;
  changePct: number;
  action: 'raise' | 'lower' | 'hold';
  holdReason: string | null;
}

/** Aplica el objetivo y los límites al precio actual. */
export function decidePrice(args: {
  currentPrice: number;
  marketPrice: number | null;
  positioningPct: number;
  demandPct: number;
  confidence: PricingConfidence;
  maxStepPct: number;
  minPrice: number | null;
  maxPrice: number | null;
  daysSinceLastChange: number | null;
  minDaysBetweenChanges: number;
}): PriceDecision {
  const current = args.currentPrice;
  const base =
    args.marketPrice != null ? args.marketPrice * (1 + args.positioningPct / 100) : current;
  const targetPrice = Math.round(base * (1 + args.demandPct / 100));
  const hold = (reason: string): PriceDecision => ({
    targetPrice,
    suggestedPrice: current,
    changePct: 0,
    action: 'hold',
    holdReason: reason,
  });
  if (current <= 0) return hold('El trastero no tiene precio.');

  // Con pocos datos, movimientos más pequeños.
  const step = args.confidence === 'low' ? args.maxStepPct / 2 : args.maxStepPct;
  const wanted = (targetPrice / current - 1) * 100;
  let suggested = Math.round(current * (1 + clamp(wanted, -step, step) / 100));
  let outOfBounds = false;
  if (args.minPrice != null && suggested < args.minPrice) {
    suggested = Math.round(args.minPrice);
    outOfBounds = current < args.minPrice;
  }
  if (args.maxPrice != null && suggested > args.maxPrice) {
    suggested = Math.round(args.maxPrice);
    outOfBounds = current > args.maxPrice;
  }

  // Si el precio actual está fuera de tus límites, se corrige siempre.
  if (!outOfBounds) {
    if (args.daysSinceLastChange != null && args.daysSinceLastChange < args.minDaysBetweenChanges) {
      return hold(`Su precio cambió hace ${args.daysSinceLastChange} días.`);
    }
    if (Math.abs((suggested / current - 1) * 100) < MIN_CHANGE_PCT) {
      return hold('El precio ya está cerca del objetivo.');
    }
  }
  if (suggested === current) return hold('El precio ya está en su límite.');

  const changePct = round1((suggested / current - 1) * 100);
  return {
    targetPrice,
    suggestedPrice: suggested,
    changePct,
    action: changePct > 0 ? 'raise' : 'lower',
    holdReason: null,
  };
}

// ---------------------------------------------------------------------------
// Tendencia del mercado y efecto de los cambios de precio (informativo: no
// mueve la sugerencia, solo se muestra).
// ---------------------------------------------------------------------------

/** Ventana de la tendencia y mínimos para que sea fiable. */
const TREND_WINDOW_DAYS = 180;
const TREND_MIN_SPAN_DAYS = 60;
const TREND_MIN_UNITS = 3;

export interface MarketTrend {
  /** Variación mediana del precio (%) entre la primera y la última revisión. */
  changePct: number;
  /** Meses que abarca (mediana). */
  months: number;
  /** Trasteros de la competencia que la respaldan. */
  units: number;
}

/**
 * Tendencia de precios de la competencia: para cada trastero con revisiones
 * separadas al menos 60 días dentro de los últimos 180, la variación entre la
 * primera y la última; se devuelve la mediana (null con menos de 3 trasteros).
 */
export function marketTrend(
  units: { observations: { observedAt: Date; price: number }[] }[],
  now: Date,
): MarketTrend | null {
  const from = now.getTime() - TREND_WINDOW_DAYS * DAY_MS;
  const changes: number[] = [];
  const spans: number[] = [];
  for (const u of units) {
    const obs = u.observations
      .filter((o) => o.observedAt.getTime() >= from && o.price > 0)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    if (obs.length < 2) continue;
    const first = obs[0]!;
    const last = obs[obs.length - 1]!;
    const span = daysBetween(first.observedAt, last.observedAt);
    if (span < TREND_MIN_SPAN_DAYS) continue;
    changes.push(((last.price - first.price) / first.price) * 100);
    spans.push(span);
  }
  if (changes.length < TREND_MIN_UNITS) return null;
  return {
    changePct: round1(median(changes)),
    months: Math.max(1, Math.round(median(spans) / 30)),
    units: changes.length,
  };
}

/**
 * Periodos libres de un trastero propio que terminaron en alquiler, a partir
 * de su historial de estados (empieza libre desde el alta). Un reservado ya
 * cuenta como alquilado.
 */
export function rentalIntervals(
  createdAt: Date,
  history: { occurredAt: Date; newStatus: string }[],
): { from: Date; to: Date }[] {
  const sorted = [...history].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const intervals: { from: Date; to: Date }[] = [];
  let freeSince: Date | null = createdAt;
  for (const h of sorted) {
    if (h.newStatus === 'available') {
      freeSince ??= h.occurredAt;
    } else if (h.newStatus === 'occupied' || h.newStatus === 'reserved') {
      if (freeSince) intervals.push({ from: freeSince, to: h.occurredAt });
      freeSince = null;
    } else {
      // Mantenimiento / bloqueado: no está a la venta, no cuenta.
      freeSince = null;
    }
  }
  return intervals;
}

/** Estado de un trastero en una fecha según su historial (libre si no hay nada antes). */
export function statusAt(history: { occurredAt: Date; newStatus: string }[], at: Date): string {
  let status = 'available';
  for (const h of [...history].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    if (h.occurredAt.getTime() > at.getTime()) break;
    status = h.newStatus;
  }
  return status;
}
