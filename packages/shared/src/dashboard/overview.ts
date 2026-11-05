import { z } from 'zod';

// --- Periodo -----------------------------------------------------------------

export const DashboardPeriodEnum = z.enum(['month', 'last_month', '3m', '12m', 'year']);
export type DashboardPeriod = z.infer<typeof DashboardPeriodEnum>;

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  month: 'Este mes',
  last_month: 'Mes pasado',
  '3m': 'Últimos 3 meses',
  '12m': 'Últimos 12 meses',
  year: 'Este año',
};

/** Días AAAA-MM-DD; `from` incluido y `to` no. */
export interface DashboardPeriodRange {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

const day = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Mismo día N meses atrás; el 31 cae en el último día del mes más corto. */
function monthsBack(y: number, m: number, d: number, months: number): [number, number, number] {
  const target = new Date(Date.UTC(y, m - months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  return [ty, tm, Math.min(d, lastDayOf(ty, tm))];
}

/**
 * Fechas de un periodo y del anterior con el que se compara. Los periodos en
 * curso se comparan hasta el mismo día, para que la comparación sea justa.
 */
export function dashboardPeriodRange(period: DashboardPeriod, today: string): DashboardPeriodRange {
  const [y, m1, d] = today.split('-').map(Number) as [number, number, number];
  const m = m1 - 1;
  const tomorrow = day(y, m, d + 1);

  if (period === 'month') {
    const [py, pm, pd] = monthsBack(y, m, d, 1);
    return {
      from: day(y, m, 1),
      to: tomorrow,
      previousFrom: day(py, pm, 1),
      previousTo: day(py, pm, pd + 1),
    };
  }
  if (period === 'last_month') {
    return {
      from: day(y, m - 1, 1),
      to: day(y, m, 1),
      previousFrom: day(y, m - 2, 1),
      previousTo: day(y, m - 1, 1),
    };
  }
  if (period === 'year') {
    const lastYearDay = Math.min(d, lastDayOf(y - 1, m));
    return {
      from: day(y, 0, 1),
      to: tomorrow,
      previousFrom: day(y - 1, 0, 1),
      previousTo: day(y - 1, m, lastYearDay + 1),
    };
  }
  const months = period === '3m' ? 3 : 12;
  const [fy, fm, fd] = monthsBack(y, m, d, months);
  const [py, pm, pd] = monthsBack(y, m, d, months * 2);
  return {
    from: day(fy, fm, fd + 1),
    to: tomorrow,
    previousFrom: day(py, pm, pd + 1),
    previousTo: day(fy, fm, fd + 1),
  };
}

// --- Cifras ------------------------------------------------------------------

export interface DashboardPeriodValuesDto {
  invoiced: number;
  collected: number;
  moveIns: number;
  moveOuts: number;
  newCustomers: number;
}

export interface DashboardPeriodFiguresDto extends DashboardPeriodValuesDto {
  period: DashboardPeriod;
  /** Quien no puede ver facturas ni cobros recibe el dinero a cero. */
  moneyVisible: boolean;
  previous: DashboardPeriodValuesDto;
}

/** Caja del mes en curso. */
export interface DashboardCashDto {
  collected: number;
  overdue: number;
  /** Sin cobrar y con el vencimiento entre hoy y fin de mes. */
  dueThisMonth: number;
  /** Emitido sin cobrar que vence más adelante. */
  dueLater: number;
  /** Si se cobra lo que vence este mes. */
  projected: number;
}

export interface DashboardVacancyDto {
  freeUnits: number;
  /** Lo que se ingresaría al mes con los trasteros libres alquilados. */
  monthlyValue: number;
  byType: {
    unitTypeId: string;
    name: string;
    free: number;
    monthlyValue: number;
    avgDaysFree: number;
  }[];
  longestFree: {
    unitId: string;
    code: string;
    facilityName: string;
    days: number;
  }[];
}

export interface DashboardMoveDto {
  contractId: string;
  customerName: string;
  unitCode: string;
  /** Día AAAA-MM-DD. */
  date: string;
}

export interface DashboardMovesDto {
  moveIns: DashboardMoveDto[];
  moveOuts: DashboardMoveDto[];
  /** Próximos 30 días. */
  upcomingMoveIns: DashboardMoveDto[];
  upcomingMoveOuts: DashboardMoveDto[];
  /** Vencen sin renovación automática. */
  expiring: DashboardMoveDto[];
}

export interface DashboardFacilityRowDto {
  facilityId: string;
  name: string;
  totalUnits: number;
  occupiedUnits: number;
  occupancyPct: number;
  mrr: number;
  overdue: number;
  moveIns: number;
  moveOuts: number;
}

export interface DashboardResultDto {
  /** Facturado sin IVA. */
  income: number;
  expenses: number;
  net: number;
  previousNet: number;
}

export interface DashboardCommercialDto {
  /** Contactos nuevos sin atender pasado el plazo de respuesta. */
  unattendedLeads: number;
  openLeads: number;
  pendingSignature: number;
  pendingPayment: number;
  waitlist: number;
}

// --- Tarjetas a medida -------------------------------------------------------

export const DASHBOARD_CARDS = [
  { id: 'suggestions', label: 'Sugerencias de hoy', wide: true },
  { id: 'seo', label: 'Aviso de SEO', wide: true },
  { id: 'kpis', label: 'Cifras principales', wide: true },
  { id: 'period', label: 'Cobrado, facturado, altas y bajas', wide: true },
  { id: 'cash', label: 'Caja del mes', wide: false },
  { id: 'result', label: 'Resultado', wide: false },
  { id: 'revenue', label: 'Ingresos de 12 meses', wide: false },
  { id: 'occupancy', label: 'Ocupación', wide: false },
  { id: 'vacancy', label: 'Trasteros libres', wide: false },
  { id: 'moves', label: 'Movimiento', wide: false },
  { id: 'facilities', label: 'Por local', wide: true },
  { id: 'commercial', label: 'Pendiente de cerrar', wide: false },
  { id: 'leads', label: 'Contactos', wide: false },
  { id: 'forecast', label: 'Previsión', wide: false },
  { id: 'aging', label: 'Deuda vencida', wide: false },
  { id: 'churn', label: 'Riesgo de baja', wide: false },
  { id: 'collections', label: 'Impagos en gestión', wide: false },
] as const;

export type DashboardCardId = (typeof DASHBOARD_CARDS)[number]['id'];

const CARD_IDS = DASHBOARD_CARDS.map((c) => c.id) as [DashboardCardId, ...DashboardCardId[]];

export const DashboardLayoutSchema = z.object({
  order: z.array(z.enum(CARD_IDS)).max(CARD_IDS.length),
  hidden: z.array(z.enum(CARD_IDS)).max(CARD_IDS.length),
});
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

/**
 * Lo guardado por el usuario, sin tarjetas retiradas ni repetidas; las nuevas
 * se colocan en su sitio por defecto, detrás de la que las precede.
 */
export function resolveDashboardLayout(saved: unknown): DashboardLayout {
  const parsed = z
    .object({ order: z.array(z.string()).optional(), hidden: z.array(z.string()).optional() })
    .safeParse(saved);
  const known = (id: string): id is DashboardCardId => (CARD_IDS as string[]).includes(id);
  const order = [...new Set((parsed.success ? (parsed.data.order ?? []) : []).filter(known))];
  const hidden = [...new Set((parsed.success ? (parsed.data.hidden ?? []) : []).filter(known))];
  CARD_IDS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = index === 0 ? undefined : CARD_IDS[index - 1];
    const at = before ? order.indexOf(before) + 1 : 0;
    order.splice(at, 0, id);
  });
  return { order, hidden };
}
