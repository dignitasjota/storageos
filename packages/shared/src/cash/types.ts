/** Forma de cobro tal como la cuenta la caja. */
export type CashMethodKey = 'cash' | 'card' | 'sepaDebit' | 'bankTransfer' | 'bizum' | 'other';

/** Resumen de cobros de un día por método de pago (para el arqueo de caja). */
export interface CashDaySummaryDto {
  date: string;
  /** Local del resumen; null = caja global del tenant. */
  facilityId: string | null;
  /** Cobrado ese día por forma de pago (un cobro devuelto después sigue contando el día que se cobró). */
  cash: number;
  card: number;
  sepaDebit: number;
  bankTransfer: number;
  bizum: number;
  other: number;
  total: number;
  /** Devoluciones a inquilinos hechas ese día, por la forma en que salió el dinero. */
  refunds: Record<CashMethodKey, number>;
  refundsTotal: number;
  /** Cobros que el banco devolvió ese día (recibos devueltos y contracargos). */
  returned: number;
  /** Devoluciones EN EFECTIVO del día (facturas): restan del efectivo esperado. */
  cashRefunds: number;
  /** Fianzas devueltas en efectivo ese día: también salen del cajón. */
  depositReturnsCash: number;
  /** Efectivo esperado en caja = `cash` − `cashRefunds` − `depositReturnsCash`. */
  expectedCash: number;
  /** Nº de cobros del día. */
  count: number;
  /** El cierre vigente de ese día, si existe (los reabiertos no cuentan). */
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
  /** Reabierto para registrar un movimiento de ese día (queda de constancia). */
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
}
