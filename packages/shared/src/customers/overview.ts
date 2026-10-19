/**
 * Visión de los inquilinos para el panel del operador: una fila por inquilino
 * con lo que paga, cómo paga, si debe algo y qué extras tiene; y el estado de
 * cuenta de su ficha.
 */

/** Cómo se le cobra: tarjeta o adeudo guardados, mandato SEPA (remesa) o nada. */
export type CustomerPayVia = 'card' | 'sepa_debit' | 'sepa_mandate' | null;

export interface CustomerOverviewDto {
  id: string;
  displayName: string;
  customerType: 'individual' | 'business';
  email: string | null;
  phone: string | null;
  tags: string[];
  kycVerified: boolean;
  portalAccessEnabled: boolean;
  createdAt: string;
  /** Trasteros de sus contratos vivos. */
  units: { code: string; facilityName: string }[];
  facilityIds: string[];
  /** Cuota mensual de sus contratos vivos (alquiler − descuento + seguro, sin IVA). */
  monthly: number;
  /** `active` si alguno sigue, `ending` si todos están en baja, `none` sin contratos vivos. */
  contractStatus: 'active' | 'ending' | 'none';
  /** Fecha de fin más cercana de sus contratos vivos. */
  endsOn: string | null;
  payVia: CustomerPayVia;
  insurance: string[];
  /** Deuda vencida (€) y desde cuándo. */
  overdue: number;
  overdueSince: string | null;
  /** Emitido y aún no vencido (€). */
  pendingNotDue: number;
  lastContactAt: string | null;
  nextFollowup: { title: string; dueDate: string } | null;
}

export interface CustomerAccountLineDto {
  contractId: string;
  contractNumber: string;
  status: string;
  unitCode: string;
  facilityName: string;
  rent: number;
  discount: number;
  insurance: number;
  insuranceName: string | null;
  /** Cuota mensual de este contrato. */
  total: number;
  billingIntervalMonths: number;
  endDate: string | null;
  depositAmount: number;
  depositStatus: string;
}

export interface CustomerDunningStepDto {
  type: string;
  label: string;
  scheduledFor: string;
  executedAt: string | null;
  status: string;
}

/** Estado de cuenta del inquilino (`GET /customers/:id/account`). */
export interface CustomerAccountDto {
  monthly: number;
  lines: CustomerAccountLineDto[];
  payVia: CustomerPayVia;
  /** «Visa ··4242», «Cuenta ··1332»… */
  payViaLabel: string | null;
  /** El negocio cobra solo al emitir la factura (y hay con qué cobrar). */
  autoCharge: boolean;
  /** Próxima factura de la cuota (aprox.: el día 1 o el fin del periodo prepagado). */
  nextCharge: { date: string; amount: number } | null;
  overdue: {
    amount: number;
    since: string;
    days: number;
    invoices: { id: string; number: string; dueDate: string; pending: number }[];
    /** Pasos del escalado de la factura más antigua. */
    steps: CustomerDunningStepDto[];
  } | null;
  pendingNotDue: number;
  /** Pagado en los últimos 12 meses. */
  paid12m: number;
  nightPasses30d: number;
}
