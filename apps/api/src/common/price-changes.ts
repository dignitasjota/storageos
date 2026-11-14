import type { Prisma } from '@storageos/database';

/**
 * Cambios de cuota ya decididos y aún sin aplicar: un cambio programado en la
 * ficha del contrato (`scheduledPrice`) o una subida de una tanda de Subidas
 * de precio. Los aplican los procesos diarios; aquí se calculan para que la
 * factura del mes, el área de clientes, «Hoy» y el calendario los conozcan
 * aunque aún no estén en `priceMonthly`.
 */
export interface PendingPriceChange {
  contractId: string;
  /** Cuota nueva (sin IVA, antes del descuento). */
  price: number;
  date: Date;
  source: 'scheduled' | 'rent_increase';
  /** Cuota que tenía al programarse (solo las subidas de una tanda). */
  oldPrice: number | null;
  rentIncreaseId: string | null;
  rentIncreaseName: string | null;
}

type Db = Pick<Prisma.TransactionClient, 'contract' | 'rentIncreaseItem'>;

/** Cambios pendientes por contrato (todos, o hasta `until`), en orden de fecha. */
export async function pendingPriceChanges(
  db: Db,
  tenantId: string,
  opts: { contractIds?: string[]; from?: Date; until?: Date } = {},
): Promise<Map<string, PendingPriceChange[]>> {
  const ids = opts.contractIds;
  if (ids && ids.length === 0) return new Map();
  const range = {
    ...(opts.from ? { gte: opts.from } : {}),
    ...(opts.until ? { lte: opts.until } : {}),
  };
  const [scheduled, items] = await Promise.all([
    db.contract.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ['active', 'ending'] },
        scheduledPrice: { not: null },
        scheduledPriceDate: { not: null, ...range },
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: { id: true, scheduledPrice: true, scheduledPriceDate: true },
    }),
    db.rentIncreaseItem.findMany({
      where: {
        tenantId,
        status: 'pending',
        rentIncrease: { status: 'scheduled' },
        ...(Object.keys(range).length > 0 ? { effectiveDate: range } : {}),
        ...(ids ? { contractId: { in: ids } } : {}),
      },
      select: {
        contractId: true,
        oldPrice: true,
        newPrice: true,
        effectiveDate: true,
        rentIncrease: { select: { id: true, name: true } },
      },
    }),
  ]);
  const out = new Map<string, PendingPriceChange[]>();
  const push = (c: PendingPriceChange) => {
    const list = out.get(c.contractId) ?? [];
    list.push(c);
    out.set(c.contractId, list);
  };
  for (const c of scheduled) {
    push({
      contractId: c.id,
      price: Number(c.scheduledPrice),
      date: c.scheduledPriceDate!,
      source: 'scheduled',
      oldPrice: null,
      rentIncreaseId: null,
      rentIncreaseName: null,
    });
  }
  for (const i of items) {
    push({
      contractId: i.contractId,
      price: Number(i.newPrice),
      date: i.effectiveDate,
      source: 'rent_increase',
      oldPrice: Number(i.oldPrice),
      rentIncreaseId: i.rentIncrease.id,
      rentIncreaseName: i.rentIncrease.name,
    });
  }
  for (const list of out.values()) list.sort(compareChanges);
  return out;
}

/** El mismo día, primero el cambio programado a mano (lo aplica antes el proceso diario). */
function compareChanges(a: PendingPriceChange, b: PendingPriceChange): number {
  const byDate = a.date.getTime() - b.date.getTime();
  if (byDate !== 0) return byDate;
  return a.source === b.source ? 0 : a.source === 'scheduled' ? -1 : 1;
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Cuota que tendrá el contrato el día `day` aplicando los cambios pendientes
 * como lo harán los procesos diarios: el cambio programado se aplica siempre;
 * la subida de una tanda, solo si la cuota sigue siendo la que se avisó.
 */
export function priceOn(current: number, changes: PendingPriceChange[], day: Date): number {
  let price = current;
  for (const c of changes) {
    if (c.date.getTime() > day.getTime()) break;
    if (c.source === 'scheduled') price = c.price;
    else if (c.oldPrice != null && sameAmount(c.oldPrice, price)) price = c.price;
  }
  return price;
}

/** El primer cambio que se aplicará de verdad, con la cuota resultante. */
export function nextPriceChange(
  current: number,
  changes: PendingPriceChange[],
): PendingPriceChange | null {
  for (const c of changes) {
    if (c.source === 'scheduled') return c;
    // Una subida de una tanda solo se aplica si la cuota sigue siendo la avisada.
    if (c.oldPrice != null && sameAmount(c.oldPrice, current)) return c;
  }
  return null;
}
