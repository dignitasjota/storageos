import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  CreatePlatformCouponInput,
  PlatformCouponDto,
  UpdatePlatformCouponInput,
} from '@storageos/shared';

/** Redondeo a 2 decimales (importes de dinero). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fila de `platform_coupons` -> DTO. */
function toDto(r: {
  id: string;
  code: string;
  discountType: string;
  discountValue: unknown;
  validUntil: Date | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PlatformCouponDto {
  return {
    id: r.id,
    code: r.code,
    discountType: r.discountType as PlatformCouponDto['discountType'],
    discountValue: Number(r.discountValue),
    validUntil: r.validUntil ? r.validUntil.toISOString() : null,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Cupones de descuento de PLATAFORMA (StorageOS -> tenant), aplicables al cobro
 * manual de la suscripción SaaS. Tabla global (sin RLS, solo super admin).
 *
 * NO confundir con `PromoCode` (descuentos del negocio del TENANT a SUS
 * inquilinos). El descuento se calcula SIEMPRE en el servidor.
 */
@Injectable()
export class PlatformCouponsService {
  constructor(private readonly admin: PrismaAdminService) {}

  async list(): Promise<PlatformCouponDto[]> {
    const rows = await this.admin.platformCoupon.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toDto);
  }

  async create(input: CreatePlatformCouponInput): Promise<PlatformCouponDto> {
    const existing = await this.admin.platformCoupon.findUnique({ where: { code: input.code } });
    if (existing) {
      throw new BadRequestException({
        code: 'coupon_code_taken',
        message: 'Ya existe un cupón con ese código.',
      });
    }
    const row = await this.admin.platformCoupon.create({
      data: {
        code: input.code,
        discountType: input.discountType,
        discountValue: input.discountValue,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        maxUses: input.maxUses ?? null,
        isActive: input.isActive,
      },
    });
    return toDto(row);
  }

  async update(id: string, input: UpdatePlatformCouponInput): Promise<PlatformCouponDto> {
    await this.findOrThrow(id);
    const row = await this.admin.platformCoupon.update({
      where: { id },
      data: {
        ...(input.discountType !== undefined ? { discountType: input.discountType } : {}),
        ...(input.discountValue !== undefined ? { discountValue: input.discountValue } : {}),
        ...(input.validUntil !== undefined
          ? { validUntil: input.validUntil ? new Date(input.validUntil) : null }
          : {}),
        ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return toDto(row);
  }

  private async findOrThrow(id: string): Promise<void> {
    const row = await this.admin.platformCoupon.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'coupon_not_found', message: 'Cupón no encontrado.' });
    }
  }

  /**
   * Valida un cupón por código y calcula el descuento sobre `amount` (nunca se
   * confía en el cliente). Lanza 400 si no es aplicable. NO incrementa el uso;
   * hay que llamar a `incrementUsage` cuando el cobro se materializa.
   */
  async validateAndComputeDiscount(
    code: string,
    amount: number,
  ): Promise<{ couponId: string; discount: number }> {
    const normalized = code.trim().toUpperCase();
    const coupon = await this.admin.platformCoupon.findUnique({ where: { code: normalized } });
    if (!coupon || !coupon.isActive) {
      throw new BadRequestException({
        code: 'coupon_invalid',
        message: 'El cupón no existe o no está activo.',
      });
    }
    if (coupon.validUntil && coupon.validUntil.getTime() < Date.now()) {
      throw new BadRequestException({ code: 'coupon_expired', message: 'El cupón ha caducado.' });
    }
    if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) {
      throw new BadRequestException({
        code: 'coupon_exhausted',
        message: 'El cupón ha alcanzado su número máximo de usos.',
      });
    }
    const value = Number(coupon.discountValue);
    const discount =
      coupon.discountType === 'percentage'
        ? round2((amount * value) / 100)
        : Math.min(round2(value), round2(amount));
    return { couponId: coupon.id, discount: round2(discount) };
  }

  /**
   * Incrementa el uso del cupón de forma ATÓMICA: el UPDATE está condicionado a
   * `used_count < max_uses` (SQL crudo, porque Prisma no compara dos columnas),
   * así una carrera de dos cobros simultáneos NUNCA sobrepasa el límite. Lanza
   * 400 `coupon_exhausted` si el cupón se agotó entre validar y cobrar.
   */
  async incrementUsage(couponId: string): Promise<void> {
    const affected = await this.admin.$executeRaw`
      UPDATE platform_coupons
      SET used_count = used_count + 1, updated_at = now()
      WHERE id = ${couponId}::uuid
        AND is_active = true
        AND (max_uses IS NULL OR used_count < max_uses)
    `;
    if (affected === 0) {
      throw new BadRequestException({
        code: 'coupon_exhausted',
        message: 'El cupón ha alcanzado su número máximo de usos.',
      });
    }
  }
}
