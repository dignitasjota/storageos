import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreatePromotionInput,
  CreateUnitOfferInput,
  PromotionDto,
  UnitOfferDto,
  UpdatePromotionInput,
  ValidatePromotionResultDto,
} from '@storageos/shared';

type PromotionRow = Prisma.PromotionGetPayload<object>;

/** Trastero al que está limitada una promoción (oferta de trastero), si lo está. */
export function promotionUnitId(appliesTo: unknown): string | null {
  if (appliesTo && typeof appliesTo === 'object' && 'unitId' in appliesTo) {
    const v = (appliesTo as { unitId?: unknown }).unitId;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/** Oferta de trastero aún usable (activa, en plazo y con usos), o null. */
export function toActiveUnitOffer(p: PromotionRow, now = new Date()): UnitOfferDto | null {
  const unitId = promotionUnitId(p.appliesTo);
  if (!unitId || !p.isActive || p.discountType !== 'free_months') return null;
  if (p.validUntil && p.validUntil < now) return null;
  if (p.maxUses !== null && p.usedCount >= p.maxUses) return null;
  return {
    promotionId: p.id,
    unitId,
    code: p.code,
    freeMonths: Math.trunc(Number(p.discountValue)),
    validUntil: (p.validUntil ?? now).toISOString(),
  };
}

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
    unitId?: string,
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
    const check = this.checkUsable(promo, unitId);
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
    unitId: string,
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
    const check = this.checkUsable(promo, unitId);
    if (check) {
      throw new ConflictException({
        code: `promotion_${check}`,
        message: this.reasonMessage(check),
      });
    }
    // Claim ATÓMICO del uso: el increment condicionado a `usedCount < maxUses`
    // evita que dos altas concurrentes superen el límite (check-then-act).
    const claimed = await tx.promotion.updateMany({
      where:
        promo.maxUses === null
          ? { id: promo.id }
          : { id: promo.id, usedCount: { lt: promo.maxUses } },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'promotion_max_uses_reached',
        message: this.reasonMessage('max_uses_reached'),
      });
    }

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

  // ---- ofertas de un trastero concreto (las crea el staff a mano) ----

  /** Ofertas activas de los trasteros indicados (todas si no se indican). */
  async activeUnitOffers(tenantId: string, unitIds?: string[]): Promise<UnitOfferDto[]> {
    const now = new Date();
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.promotion.findMany({
          where: {
            tenantId,
            isActive: true,
            discountType: 'free_months',
            OR: [{ validUntil: null }, { validUntil: { gt: now } }],
          },
        }),
      tenantId,
    );
    const wanted = unitIds ? new Set(unitIds) : null;
    return rows
      .map((r) => toActiveUnitOffer(r, now))
      .filter((o): o is UnitOfferDto => o !== null && (!wanted || wanted.has(o.unitId)));
  }

  async createUnitOffer(tenantId: string, input: CreateUnitOfferInput): Promise<UnitOfferDto> {
    const unit = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findFirst({
          where: { id: input.unitId, tenantId },
          select: { id: true, code: true, status: true },
        }),
      tenantId,
    );
    if (!unit) {
      throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
    }
    if (unit.status !== 'available') {
      throw new BadRequestException({
        code: 'unit_not_available',
        message: 'Solo se puede crear una oferta para un trastero disponible',
      });
    }
    const existing = await this.activeUnitOffers(tenantId, [unit.id]);
    if (existing.length > 0) {
      throw new ConflictException({
        code: 'unit_offer_exists',
        message: 'Este trastero ya tiene una oferta activa',
      });
    }
    const slug =
      unit.code
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 20) || 'T';
    const code = `OF-${slug}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const now = new Date();
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.promotion.create({
          data: {
            tenantId,
            code,
            name: `Oferta trastero ${unit.code}`,
            discountType: 'free_months',
            discountValue: input.freeMonths,
            appliesTo: { unitId: unit.id },
            maxUses: 1,
            validFrom: now,
            validUntil: new Date(now.getTime() + input.validDays * 86_400_000),
          },
        }),
      tenantId,
    );
    return toActiveUnitOffer(created, now)!;
  }

  /** Retira la oferta activa de un trastero (la desactiva; no la borra). */
  async cancelUnitOffer(tenantId: string, unitId: string): Promise<void> {
    const offers = await this.activeUnitOffers(tenantId, [unitId]);
    if (offers.length === 0) {
      throw new NotFoundException({
        code: 'unit_offer_not_found',
        message: 'Este trastero no tiene una oferta activa',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.promotion.updateMany({
          where: { id: { in: offers.map((o) => o.promotionId) } },
          data: { isActive: false },
        }),
      tenantId,
    );
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
  private checkUsable(promo: PromotionRow, unitId?: string): string | null {
    const now = new Date();
    const onlyUnit = promotionUnitId(promo.appliesTo);
    if (onlyUnit && onlyUnit !== unitId) return 'not_for_unit';
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
      case 'not_for_unit':
        return 'Esta oferta es solo para otro trastero';
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
