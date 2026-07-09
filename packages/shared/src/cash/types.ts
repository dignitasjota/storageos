/** Resumen de cobros de un día por método de pago (para el arqueo de caja). */
export interface CashDaySummaryDto {
  date: string;
  /** Local del resumen; null = caja global del tenant. */
  facilityId: string | null;
  cash: number;
  card: number;
  sepaDebit: number;
  bankTransfer: number;
  other: number;
  total: number;
  /** Reembolsos EN EFECTIVO del día (restan del efectivo esperado en caja). */
  cashRefunds: number;
  /** Efectivo neto esperado en caja = `cash` − `cashRefunds`. */
  expectedCash: number;
  /** Nº de cobros del día. */
  count: number;
  /** El cierre ya registrado de ese día, si existe. */
  closure: CashClosureDto | null;
}

/** Un cierre de caja registrado (arqueo). */
export interface CashClosureDto {
  id: string;
  date: string;
  facilityId: string | null;
  facilityName: string | null;
  expectedCash: number;
  countedCash: number;
  difference: number;
  notes: string | null;
  closedByName: string | null;
  closedAt: string;
}
