import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreatePromotionInput,
  PromotionDto,
  UpdatePromotionInput,
  ValidatePromotionResultDto,
} from '@storageos/shared';

type PromotionRow = Prisma.PromotionGetPayload<object>;

/** Redondea a céntimos (2 decimales). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(p: PromotionRow): PromotionDto {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      discountType: p.discountType,
      discountValue: Number(p.discountValue),
      appliesTo: (p.appliesTo as Record<string, unknown>) ?? {},
      maxUses: p.maxUses,
      usedCount: p.usedCount,
      validFrom: p.validFrom?.toISOString() ?? null,
      validUntil: p.validUntil?.toISOString() ?? null,
      isActive: p.isActive,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async list(tenantId: string): Promise<PromotionDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.promotion.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(tenantId: string, input: CreatePromotionInput): Promise<PromotionDto> {
    try {
      const created = await this.prisma.withTenant(
        (tx) =>
          tx.promotion.create({
            data: {
              tenantId,
              code: input.code,
              name: input.name,
              discountType: input.discountType,
              discountValue: input.discountValue,
              appliesTo: input.appliesTo as Prisma.InputJsonValue,
              maxUses: input.maxUses ?? null,
              validFrom: input.validFrom ? new Date(input.validFrom) : null,
              validUntil: input.validUntil ? new Date(input.validUntil) : null,
              isActive: input.isActive,
            },
          }),
        tenantId,
      );
      return this.toDto(created);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'promotion_code_taken',
          message: 'Ya existe una promoción con ese código',
        });
      }
      throw err;
    }
  }

  async update(tenantId: string, id: string, input: UpdatePromotionInput): Promise<PromotionDto> {
    await this.findOrThrow(tenantId, id);
    const data: Prisma.PromotionUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.discountType !== undefined) data.discountType = input.discountType;
    if (input.discountValue !== undefined) data.discountValue = input.discountValue;
    if (input.appliesTo !== undefined) data.appliesTo = input.appliesTo as Prisma.InputJsonValue;
    if (input.maxUses !== undefined) data.maxUses = input.maxUses;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.validFrom !== undefined)
      data.validFrom = input.validFrom ? new Date(input.validFrom) : null;
    if (input.validUntil !== undefined)
      data.validUntil = input.validUntil ? new Date(input.validUntil) : null;

    const updated = await this.prisma.withTenant(
      (tx) => tx.promotion.update({ where: { id }, data }),
      tenantId,
    );
    return this.toDto(updated);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant((tx) => tx.promotion.delete({ where: { id } }), tenantId);
  }

  /** Previsualiza el descuento de un código sobre un precio mensual. */
  async validate(
    tenantId: string,
    code: string,
    monthlyPrice: number,
  ): Promise<ValidatePromotionResultDto> {
    const normalized = code.trim().toUpperCase();
    const promo = await this.prisma.withTenant(
      (tx) => tx.promotion.findFirst({ where: { tenantId, code: normalized } }),
      tenantId,
    );
    const fail = (reason: string): ValidatePromotionResultDto => ({
      valid: false,
      reason,
      code: normalized,
      discountType: null,
      discountAmount: 0,
      effectivePrice: round2(monthlyPrice),
      freeMonths: null,
    });
    if (!promo) return fail('not_found');
    const check = this.checkUsable(promo);
    if (check) return fail(check);

    // free_months: no es un descuento mensual; son las primeras N facturas
    // gratis. El precio mensual queda intacto y se informa `freeMonths`.
    if (promo.discountType === 'free_months') {
      return {
        valid: true,
        reason: null,
        code: promo.code,
        discountType: 'free_months',
        discountAmount: 0,
        effectivePrice: round2(monthlyPrice),
        freeMonths: Math.max(0, Math.trunc(Number(promo.discountValue))),
      };
    }

    const discountAmount = this.computeDiscount(promo, monthlyPrice);
    return {
      valid: true,
      reason: null,
      code: promo.code,
      discountType: promo.discountType,
      discountAmount,
      effectivePrice: round2(monthlyPrice - discountAmount),
      freeMonths: null,
    };
  }

  /**
   * Aplica un código en el alta de un contrato DENTRO de su transacción:
   * valida, calcula el descuento mensual y marca un uso (incrementa
   * `used_count`). Lanza si el código no es válido. Solo percentage/fixed.
   */
  async applyToContractTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    code: string,
    monthlyPrice: number,
  ): Promise<{
    discountAmount: number;
    discountReason: string;
    freeMonths: number;
    promotionId: string;
  }> {
    const normalized = code.trim().toUpperCase();
    const promo = await tx.promotion.findFirst({ where: { tenantId, code: normalized } });
    if (!promo) {
      throw new NotFoundException({
        code: 'promotion_not_found',
        message: 'Código promocional no encontrado',
      });
    }
    const check = this.checkUsable(promo);
    if (check) {
      throw new ConflictException({
        code: `promotion_${check}`,
        message: this.reasonMessage(check),
      });
    }
    await tx.promotion.update({ where: { id: promo.id }, data: { usedCount: { increment: 1 } } });

    if (promo.discountType === 'free_months') {
      const freeMonths = Math.max(0, Math.trunc(Number(promo.discountValue)));
      const label = freeMonths === 1 ? '1 mes gratis' : `${freeMonths} meses gratis`;
      return {
        discountAmount: 0,
        discountReason: `Promoción ${promo.code} (${label})`,
        freeMonths,
        promotionId: promo.id,
      };
    }

    const discountAmount = this.computeDiscount(promo, monthlyPrice);
    return {
      discountAmount,
      discountReason: `Promoción ${promo.code}`,
      freeMonths: 0,
      promotionId: promo.id,
    };
  }

  // -------------------------------------------------------------------

  private async findOrThrow(tenantId: string, id: string): Promise<PromotionRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.promotion.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'promotion_not_found',
        message: 'Promoción no encontrada',
      });
    }
    return row;
  }

  /** Devuelve el motivo si NO es usable, o null si lo es. */
  private checkUsable(promo: PromotionRow): string | null {
    const now = new Date();
    if (!promo.isActive) return 'inactive';
    if (promo.validFrom && promo.validFrom > now) return 'not_started';
    if (promo.validUntil && promo.validUntil < now) return 'expired';
    if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) return 'max_uses_reached';
    return null;
  }

  private computeDiscount(promo: PromotionRow, monthlyPrice: number): number {
    const value = Number(promo.discountValue);
    const raw =
      promo.discountType === 'percentage'
        ? (monthlyPrice * value) / 100
        : Math.min(value, monthlyPrice);
    return Math.min(round2(raw), round2(monthlyPrice));
  }

  private reasonMessage(reason: string): string {
    switch (reason) {
      case 'inactive':
        return 'La promoción no está activa';
      case 'not_started':
        return 'La promoción aún no es válida';
      case 'expired':
        return 'La promoción ha caducado';
      case 'max_uses_reached':
        return 'La promoción ha alcanzado su límite de usos';
      default:
        return 'Código promocional no válido';
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
