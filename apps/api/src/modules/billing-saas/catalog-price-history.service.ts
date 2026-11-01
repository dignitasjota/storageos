import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { CatalogPriceChangeDto } from '@storageos/shared';

const n = (v: unknown): number | null => (v == null ? null : Number(v));

/** Histórico de cambios de precio de planes y extras del catálogo. */
@Injectable()
export class CatalogPriceHistoryService {
  constructor(private readonly admin: PrismaAdminService) {}

  /** Anota un cambio si el precio mensual o anual ha cambiado. Best-effort. */
  async record(args: {
    kind: 'plan' | 'addon';
    itemId: string;
    itemName: string;
    oldMonthly: number | null;
    newMonthly: number | null;
    oldYearly?: number | null;
    newYearly?: number | null;
    superAdminId: string | null;
  }): Promise<void> {
    const monthlyChanged = args.oldMonthly !== args.newMonthly;
    const yearlyChanged = (args.oldYearly ?? null) !== (args.newYearly ?? null);
    if (!monthlyChanged && !yearlyChanged) return;
    await this.admin.catalogPriceHistory
      .create({
        data: {
          kind: args.kind,
          itemId: args.itemId,
          itemName: args.itemName,
          oldPriceMonthly: args.oldMonthly,
          newPriceMonthly: args.newMonthly,
          oldPriceYearly: args.oldYearly ?? null,
          newPriceYearly: args.newYearly ?? null,
          superAdminId: args.superAdminId,
        },
      })
      .catch(() => undefined);
  }

  async list(kind: 'plan' | 'addon', itemId?: string): Promise<CatalogPriceChangeDto[]> {
    const rows = await this.admin.catalogPriceHistory.findMany({
      where: { kind, ...(itemId ? { itemId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const adminIds = [...new Set(rows.map((r) => r.superAdminId).filter((x): x is string => !!x))];
    const admins = adminIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const names = new Map(admins.map((a) => [a.id, a.fullName]));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'plan' | 'addon',
      itemId: r.itemId,
      itemName: r.itemName,
      oldPriceMonthly: n(r.oldPriceMonthly),
      newPriceMonthly: n(r.newPriceMonthly),
      oldPriceYearly: n(r.oldPriceYearly),
      newPriceYearly: n(r.newPriceYearly),
      superAdminName: r.superAdminId ? (names.get(r.superAdminId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
