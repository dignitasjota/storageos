import type { CashMovementKind } from './schemas';

/** Forma de cobro tal como la cuenta la caja. */
export type CashMethodKey = 'cash' | 'card' | 'sepaDebit' | 'bankTransfer' | 'bizum' | 'other';

/** Un movimiento de caja que no es un cobro (fondo, cambio, retirada). */
export interface CashMovementDto {
  id: string;
  date: string;
  facilityId: string | null;
  facilityName: string | null;
  kind: CashMovementKind;
  amount: number;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** Un apunte de efectivo del día: un cobro, una devolución o una fianza devuelta. */
export interface CashLineDto {
  kind: 'payment' | 'refund' | 'deposit_return';
  /** Positivo si entra en el cajón, negativo si sale. */
  amount: number;
  at: string;
  customerId: string | null;
  customerName: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  contractId: string | null;
}

/** De dónde salía el efectivo esperado al cerrar. */
export interface CashClosureBreakdownDto {
  cashIn: number;
  cashRefunds: number;
  depositReturnsCash: number;
  movementsIn: number;
  movementsOut: number;
  /** Cobrado ese día por forma de pago. */
  byMethod: Record<CashMethodKey, number>;
  movements: { kind: CashMovementKind; amount: number; notes: string | null }[];
}

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
  /** Fondo, cambio y retiradas del día (todos los de la empresa en la caja global). */
  movements: CashMovementDto[];
  movementsIn: number;
  movementsOut: number;
  /** El último fondo de apertura de esta caja (para proponerlo). */
  lastOpeningFloat: number | null;
  /** Cada cobro, devolución o fianza en efectivo del día (los 200 más recientes). */
  cashLines: CashLineDto[];
  /**
   * Efectivo esperado en caja = `cash` − `cashRefunds` − `depositReturnsCash`
   * + `movementsIn` − `movementsOut`.
   */
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
  /** Recuento por billetes y monedas: { "<céntimos>": unidades }. */
  denominations: Record<string, number> | null;
  breakdown: CashClosureBreakdownDto | null;
}
