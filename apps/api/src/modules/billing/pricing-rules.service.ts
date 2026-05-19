import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { Prisma, PriceModifierType, Promotion } from '@storageos/database';

interface ResolveArgs {
  tenantId: string;
  basePrice: number;
  unitId: string;
  unitTypeId: string;
  facilityId: string;
  /** Codigo de promotion aplicado manualmente (opcional). */
  promotionCode?: string;
  /** Fecha en la que se aplica (default: now). */
  at?: Date;
}

interface ResolveResult {
  basePrice: number;
  appliedRules: Array<{ id: string; name: string; delta: number }>;
  appliedPromotion: { id: string; code: string; delta: number } | null;
  /** Precio final tras aplicar reglas + promotion (puede ser 0). */
  effectivePrice: number;
}

/**
 * Resuelve el precio efectivo aplicando `pricing_rules` activas + (opcionalmente)
 * una `promotion` por codigo. En Fase 4 las condiciones JSONB no se
 * interpretan completamente: cada regla aplica si `valid_from <= at <=
 * valid_until` y el scope/targetId encajan. La logica avanzada (ocupacion %,
 * duracion, estacional) se introducira con feature flags por regla.
 *
 * Algoritmo:
 *   1. Filtrar pricing_rules activas que apliquen al unit (scope unit con
 *      target_id = unitId, scope unit_type con target_id = unitTypeId, etc.)
 *      y al periodo (valid_from/valid_until cubren `at`).
 *   2. Ordenar por priority DESC.
 *   3. Aplicar cada modifier en cascada al precio base.
 *   4. Si hay promotion code, aplicar discount al final.
 *   5. Clamp a 0 si sale negativo.
 */
@Injectable()
export class PricingRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(args: ResolveArgs): Promise<ResolveResult> {
    const at = args.at ?? new Date();
    const rules = await this.prisma.withTenant(
      (tx) =>
        tx.pricingRule.findMany({
          where: {
            isActive: true,
            OR: [
              { scope: 'tenant', targetId: null },
              { scope: 'facility', targetId: args.facilityId },
              { scope: 'unit_type', targetId: args.unitTypeId },
              { scope: 'unit', targetId: args.unitId },
            ],
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: at } }] },
              { OR: [{ validUntil: null }, { validUntil: { gte: at } }] },
            ],
          },
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        }),
      args.tenantId,
    );

    let price = args.basePrice;
    const appliedRules: ResolveResult['appliedRules'] = [];
    for (const rule of rules) {
      const before = price;
      price = this.applyModifier(price, rule.modifierType, Number(rule.modifierValue));
      appliedRules.push({ id: rule.id, name: rule.name, delta: price - before });
    }

    let appliedPromotion: ResolveResult['appliedPromotion'] = null;
    if (args.promotionCode) {
      const promo = await this.prisma.withTenant(
        (tx) =>
          tx.promotion.findFirst({
            where: {
              code: args.promotionCode!.trim().toUpperCase(),
              isActive: true,
              AND: [
                { OR: [{ validFrom: null }, { validFrom: { lte: at } }] },
                { OR: [{ validUntil: null }, { validUntil: { gte: at } }] },
              ],
            },
          }),
        args.tenantId,
      );
      if (promo && this.promotionApplies(promo, args)) {
        const before = price;
        price = this.applyPromotion(price, promo);
        appliedPromotion = { id: promo.id, code: promo.code, delta: price - before };
      }
    }

    const effective = Math.max(0, Math.round(price * 100) / 100);
    return {
      basePrice: args.basePrice,
      appliedRules,
      appliedPromotion,
      effectivePrice: effective,
    };
  }

  /**
   * Marca una promotion como usada (incrementa `used_count`). Llamado por
   * `InvoicesService.issue` cuando la promotion realmente se aplicó.
   */
  async incrementPromotionUse(tx: Prisma.TransactionClient, promotionId: string): Promise<void> {
    await tx.promotion.update({
      where: { id: promotionId },
      data: { usedCount: { increment: 1 } },
    });
  }

  private applyModifier(price: number, type: PriceModifierType, value: number): number {
    if (type === 'percentage') {
      return price + (price * value) / 100;
    }
    return price + value;
  }

  private applyPromotion(price: number, promo: Promotion): number {
    const value = Number(promo.discountValue);
    if (promo.discountType === 'percentage') {
      return price - (price * value) / 100;
    }
    if (promo.discountType === 'fixed') {
      return price - value;
    }
    // free_months: en una factura puntual significa precio = 0 si el
    // periodo cae dentro del rango de la promo (simplificado).
    return 0;
  }

  private promotionApplies(promo: Promotion, _args: ResolveArgs): boolean {
    if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) return false;
    // `applies_to` jsonb se interpreta en Fase 4+ para filtrar por
    // unit_type/facility. De momento aplica a todo si esta activa.
    return true;
  }
}
