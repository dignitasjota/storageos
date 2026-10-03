import type { PrismaAdminService } from '../database/prisma-admin.service';

export interface PlatformPricing {
  /** Los precios de planes y extras ya incluyen el IVA. */
  includeVat: boolean;
  taxRate: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cómo se cobran los precios de la plataforma (IVA incluido o +IVA). */
export async function platformPricing(admin: PrismaAdminService): Promise<PlatformPricing> {
  const s = await admin.platformBillingSettings.findFirst({
    select: { pricesIncludeVat: true, taxRate: true },
  });
  return { includeVat: s?.pricesIncludeVat ?? true, taxRate: Number(s?.taxRate ?? 21) };
}

/**
 * Importe a cobrar por un precio de lista: el mismo si incluye el IVA, o el
 * precio más el IVA si es +IVA. La factura deriva base y cuota del total
 * cobrado en ambos casos.
 */
export function amountToCharge(listPrice: number, p: PlatformPricing): number {
  return p.includeVat ? round2(listPrice) : round2(listPrice * (1 + p.taxRate / 100));
}
