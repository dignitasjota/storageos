import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { StripeGateway } from '../payments/stripe.gateway';

import type { PlatformCoupon } from '@storageos/database';
import type {
  CreatePlatformCouponInput,
  PlatformCouponDto,
  PlatformCouponRedemptionsDto,
  UpdatePlatformCouponInput,
} from '@storageos/shared';

/** Redondeo a 2 decimales (importes de dinero). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fila de `platform_coupons` -> DTO. */
function toDto(r: PlatformCoupon): PlatformCouponDto {
  return {
    id: r.id,
    code: r.code,
    discountType: r.discountType as PlatformCouponDto['discountType'],
    discountValue: Number(r.discountValue),
    validUntil: r.validUntil ? r.validUntil.toISOString() : null,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    isActive: r.isActive,
    planIds: r.planIds,
    durationMonths: r.durationMonths,
    oncePerTenant: r.oncePerTenant,
    validFrom: r.validFrom ? r.validFrom.toISOString() : null,
    stripeReady: !!r.stripeCouponId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Cupones de descuento de PLATAFORMA (TrasterOS -> tenant), aplicables al cobro
 * manual de la suscripción SaaS. Tabla global (sin RLS, solo super admin).
 *
 * NO confundir con `PromoCode` (descuentos del negocio del TENANT a SUS
 * inquilinos). El descuento se calcula SIEMPRE en el servidor.
 */
@Injectable()
export class PlatformCouponsService {
  private readonly logger = new Logger(PlatformCouponsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly stripeGateway: StripeGateway,
  ) {}

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
        planIds: input.planIds ?? [],
        durationMonths: input.durationMonths ?? null,
        oncePerTenant: input.oncePerTenant ?? false,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
      },
    });
    return toDto(await this.syncStripe(row, true));
  }

  async update(id: string, input: UpdatePlatformCouponInput): Promise<PlatformCouponDto> {
    const current = await this.findOrThrow(id);
    // Al cambiar solo el tipo o solo el valor, la combinación final también
    // tiene que ser válida (un % nunca por encima del 100).
    const type = input.discountType ?? current.discountType;
    const value = input.discountValue ?? Number(current.discountValue);
    if (type === 'percentage' && value > 100) {
      throw new BadRequestException({
        code: 'coupon_percentage_too_high',
        message: 'Un descuento porcentual no puede superar el 100 %.',
      });
    }
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
        ...(input.planIds !== undefined ? { planIds: input.planIds } : {}),
        ...(input.durationMonths !== undefined ? { durationMonths: input.durationMonths } : {}),
        ...(input.oncePerTenant !== undefined ? { oncePerTenant: input.oncePerTenant } : {}),
        ...(input.validFrom !== undefined
          ? { validFrom: input.validFrom ? new Date(input.validFrom) : null }
          : {}),
      },
    });
    // En Stripe un cupón no se puede editar: si cambia lo que descuenta, se
    // sustituye por uno nuevo (las suscripciones que ya lo llevan siguen igual).
    const stripeFieldsChanged =
      row.discountType !== current.discountType ||
      Number(row.discountValue) !== Number(current.discountValue) ||
      row.durationMonths !== current.durationMonths ||
      row.maxUses !== current.maxUses ||
      (row.validUntil?.getTime() ?? null) !== (current.validUntil?.getTime() ?? null) ||
      row.isActive !== current.isActive;
    return toDto(await this.syncStripe(row, stripeFieldsChanged));
  }

  /**
   * Borra un cupón que nunca se ha usado (uno con usos se desactiva: los pagos
   * y facturas que lo llevan siguen siendo la prueba del descuento).
   */
  async remove(id: string): Promise<void> {
    const row = await this.findOrThrow(id);
    const uses = await this.admin.platformCouponRedemption.count({ where: { couponId: id } });
    if (row.usedCount > 0 || uses > 0) {
      throw new ConflictException({
        code: 'coupon_in_use',
        message: 'El cupón ya se ha usado: desactívalo en vez de borrarlo.',
      });
    }
    await this.deleteStripeCoupon(row.stripeCouponId);
    await this.admin.platformCoupon.delete({ where: { id } });
  }

  /** Quién lo ha usado, cuándo y cuánto ha descontado en total. */
  async redemptions(id: string): Promise<PlatformCouponRedemptionsDto> {
    await this.findOrThrow(id);
    const rows = await this.admin.platformCouponRedemption.findMany({
      where: { couponId: id },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { tenant: { select: { name: true } } },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        source: r.source as 'manual' | 'stripe',
        discount: r.discount == null ? null : Number(r.discount),
        createdAt: r.createdAt.toISOString(),
      })),
      totalDiscount: round2(rows.reduce((sum, r) => sum + Number(r.discount ?? 0), 0)),
      tenants: new Set(rows.map((r) => r.tenantId)).size,
    };
  }

  /** Anota un uso (pago a mano o suscripción de Stripe). Best-effort. */
  async recordRedemption(args: {
    couponId: string;
    tenantId: string;
    source: 'manual' | 'stripe';
    paymentId?: string | null;
    discount?: number | null;
  }): Promise<void> {
    await this.admin.platformCouponRedemption
      .create({
        data: {
          couponId: args.couponId,
          tenantId: args.tenantId,
          source: args.source,
          paymentId: args.paymentId ?? null,
          discount: args.discount ?? null,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(`No se pudo anotar el uso del cupón ${args.couponId}: ${String(err)}`),
      );
  }

  /**
   * Mantiene el espejo del cupón en Stripe (para el Checkout y el cambio de
   * plan). Sin Stripe configurado no hace nada: el cupón vale solo para los
   * pagos a mano.
   */
  private async syncStripe(row: PlatformCoupon, recreate: boolean): Promise<PlatformCoupon> {
    if (!this.stripeGateway.isConfigured()) return row;
    if (!row.isActive) {
      if (!row.stripeCouponId) return row;
      await this.deleteStripeCoupon(row.stripeCouponId);
      return this.admin.platformCoupon.update({
        where: { id: row.id },
        data: { stripeCouponId: null },
      });
    }
    if (row.stripeCouponId && !recreate) return row;
    try {
      const value = Number(row.discountValue);
      const created = await this.stripeGateway.getClient().coupons.create({
        name: row.code,
        ...(row.discountType === 'percentage'
          ? { percent_off: Math.min(value, 100) }
          : { amount_off: Math.round(value * 100), currency: 'eur' }),
        ...(row.durationMonths
          ? { duration: 'repeating' as const, duration_in_months: row.durationMonths }
          : { duration: 'forever' as const }),
        ...(row.maxUses != null ? { max_redemptions: row.maxUses } : {}),
        ...(row.validUntil ? { redeems_by: Math.floor(row.validUntil.getTime() / 1000) } : {}),
        metadata: { platformCouponId: row.id },
      });
      await this.deleteStripeCoupon(row.stripeCouponId);
      return this.admin.platformCoupon.update({
        where: { id: row.id },
        data: { stripeCouponId: created.id },
      });
    } catch (err) {
      this.logger.warn(`No se pudo crear el cupón ${row.code} en Stripe: ${String(err)}`);
      return row;
    }
  }

  private async deleteStripeCoupon(id: string | null): Promise<void> {
    if (!id || !this.stripeGateway.isConfigured()) return;
    await this.stripeGateway
      .getClient()
      .coupons.del(id)
      .catch(() => undefined);
  }

  private async findOrThrow(id: string) {
    const row = await this.admin.platformCoupon.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'coupon_not_found', message: 'Cupón no encontrado.' });
    }
    return row;
  }

  /**
   * Valida un cupón por código y calcula el descuento sobre `amount` (nunca se
   * confía en el cliente). Lanza 400 si no es aplicable. NO incrementa el uso;
   * hay que llamar a `incrementUsage` cuando el cobro se materializa.
   */
  async validateAndComputeDiscount(
    code: string,
    amount: number,
    ctx: { tenantId?: string | null; planId?: string | null } = {},
  ): Promise<{ couponId: string; discount: number; stripeCouponId: string | null }> {
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
    if (coupon.validFrom && coupon.validFrom.getTime() > Date.now()) {
      throw new BadRequestException({
        code: 'coupon_not_yet_valid',
        message: 'El cupón todavía no se puede usar.',
      });
    }
    if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) {
      throw new BadRequestException({
        code: 'coupon_exhausted',
        message: 'El cupón ha alcanzado su número máximo de usos.',
      });
    }
    if (ctx.planId && coupon.planIds.length > 0 && !coupon.planIds.includes(ctx.planId)) {
      throw new BadRequestException({
        code: 'coupon_not_for_plan',
        message: 'El cupón no vale para este plan.',
      });
    }
    // Usos por tenant: «solo una vez» o «las primeras N cuotas» (en los pagos a
    // mano, cada pago con el cupón cuenta como una cuota).
    const perTenant = coupon.durationMonths ?? (coupon.oncePerTenant ? 1 : null);
    if (ctx.tenantId && perTenant != null) {
      const used = await this.admin.platformCouponRedemption.count({
        where: { couponId: coupon.id, tenantId: ctx.tenantId },
      });
      if (used >= perTenant) {
        throw new BadRequestException({
          code: 'coupon_already_used',
          message:
            perTenant === 1
              ? 'Este tenant ya ha usado el cupón.'
              : `Este tenant ya ha usado el cupón en sus ${perTenant} primeras cuotas.`,
        });
      }
    }
    const value = Number(coupon.discountValue);
    const discount =
      coupon.discountType === 'percentage'
        ? round2((amount * Math.min(value, 100)) / 100)
        : Math.min(round2(value), round2(amount));
    return {
      couponId: coupon.id,
      discount: round2(discount),
      stripeCouponId: coupon.stripeCouponId,
    };
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
