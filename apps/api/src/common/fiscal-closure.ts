import { ConflictException } from '@nestjs/common';

import type { Prisma } from '@storageos/database';

/** Año y trimestre (1-4) de una fecha (columna DATE, en UTC). */
export function quarterOf(date: Date): { year: number; quarter: number } {
  return { year: date.getUTCFullYear(), quarter: Math.floor(date.getUTCMonth() / 3) + 1 };
}

/** Trimestres cerrados (sin reabrir) de la empresa, como «2026-3». */
export async function closedQuarters(tx: Prisma.TransactionClient): Promise<Set<string>> {
  const rows = await tx.fiscalPeriodClosure.findMany({
    where: { reopenedAt: null },
    select: { year: true, quarter: true },
  });
  return new Set(rows.map((r) => `${r.year}-${r.quarter}`));
}

export function isClosed(closed: Set<string>, date: Date): boolean {
  const q = quarterOf(date);
  return closed.has(`${q.year}-${q.quarter}`);
}

/**
 * 409 si alguna de las fechas cae en un trimestre cerrado en Fiscalidad: lo
 * declarado de ese periodo no se cambia sin reabrirlo antes.
 */
export async function assertFiscalPeriodOpen(
  tx: Prisma.TransactionClient,
  dates: (Date | null | undefined)[],
  what: string,
): Promise<void> {
  const list = dates.filter((d): d is Date => !!d);
  if (list.length === 0) return;
  const closed = await closedQuarters(tx);
  const hit = list.find((d) => isClosed(closed, d));
  if (!hit) return;
  const q = quarterOf(hit);
  throw new ConflictException({
    code: 'fiscal_period_closed',
    message: `El ${q.quarter}.º trimestre de ${q.year} está cerrado en Fiscalidad: no se puede cambiar ${what}. Si hace falta, reábrelo antes.`,
    details: { year: q.year, quarter: q.quarter },
  });
}
