import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  couponRejectMessage,
  couponRuleIssues,
  publicCouponRejectMessage,
  buildFirstPaymentQuote,
  firstMonthPlan,
  parsePromoLandingContent,
  quoteCoupon,
  rentTax,
  type CouponDto,
  type CouponKind,
  type CouponQuote,
  type CouponQuoteContext,
  type CouponQuoteDto,
  type CouponRedemptionDto,
  type CouponResultsDto,
  type CouponRules,
  type CouponSettingsDto,
  type CreateCouponInput,
  type CreatePersonalCouponInput,
  type FirstPaymentQuoteDto,
  type UpdateCouponInput,
  type UpdateCouponSettingsInput,
  type ValidateCouponInput,
} from '@storageos/shared';

import { CUSTOMER_CONTRACT_WHERE } from '../../common/online-booking';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';

type CouponRow = Prisma.CouponGetPayload<object>;

/** Uso de un cupón ya comprobado y reservado (lo guarda quien lo aplica). */
export interface RedeemedCoupon {
  couponId: string;
  code: string;
  name: string;
  quote: Extract<CouponQuote, { valid: true }>;
}

function toRules(c: CouponRow): CouponRules {
  return {
    discountType: c.discountType,
    discountValue: Number(c.discountValue),
    minMonths: c.minMonths,
    minAmount: c.minAmount === null ? null : Number(c.minAmount),
    unitTypeIds: c.unitTypeIds,
    facilityIds: c.facilityIds,
    newCustomersOnly: c.newCustomersOnly,
    oncePerCustomer: c.oncePerCustomer,
    preOpeningOnly: c.preOpeningOnly,
    maxUses: c.maxUses,
    usedCount: c.usedCount,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    isActive: c.isActive,
  };
}

const normalizeCode = (code: string): string => code.trim().toUpperCase();

/** Código del cupón del recomendado (si está cogido, con un sufijo). */
const REFERRAL_FRIEND_CODES = ['AMIGO', 'RECOMENDADO', 'AMIGO-REF', 'RECOMENDADO-REF'];
// Sin caracteres que se confunden (0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/**
 * Cupones: descuento sobre el pago que se hace en ese momento (no sobre las
 * renovaciones). El cálculo es `quoteCoupon` (shared, también lo usa la web);
 * aquí se cargan los datos, se reserva el uso y se guarda cada aplicación.
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private toDto(c: CouponRow): CouponDto {
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      discountType: c.discountType,
      discountValue: Number(c.discountValue),
      minMonths: c.minMonths,
      minAmount: c.minAmount === null ? null : Number(c.minAmount),
      unitTypeIds: c.unitTypeIds,
      facilityIds: c.facilityIds,
      newCustomersOnly: c.newCustomersOnly,
      oncePerCustomer: c.oncePerCustomer,
      preOpeningOnly: c.preOpeningOnly,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      validFrom: c.validFrom?.toISOString() ?? null,
      validUntil: c.validUntil?.toISOString() ?? null,
      isActive: c.isActive,
      announceOnWeb: c.announceOnWeb,
      kind: (c.kind as CouponKind) ?? 'standard',
      personalFor: c.personalFor,
      createdAt: c.createdAt.toISOString(),
    };
  }

  /** Cupones del negocio y personales (el del recomendado lo lleva Referidos). */
  async list(tenantId: string): Promise<CouponDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.coupon.findMany({
          where: { tenantId, kind: { not: 'referral_friend' } },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Cupón personal: un solo uso, con caducidad y código puesto por el sistema.
   * Para un presupuesto o para quien dejó la reserva a medias.
   */
  async createPersonal(
    tenantId: string,
    input: CreatePersonalCouponInput,
    userId: string | null = null,
  ): Promise<CouponDto> {
    const validUntil = new Date(Date.now() + input.validDays * 86_400_000);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await this.prisma.withTenant(
          (tx) =>
            tx.coupon.create({
              data: {
                tenantId,
                code: `P-${randomCode(6)}`,
                name: `Cupón personal — ${input.personalFor}`.slice(0, 120),
                discountType: input.discountType,
                discountValue: input.discountValue,
                minMonths: input.minMonths,
                maxUses: 1,
                validUntil,
                kind: 'personal',
                personalFor: input.personalFor,
              },
            }),
          tenantId,
        );
        await this.audit.write({
          tenantId,
          userId,
          action: 'coupon.created',
          entityType: 'Coupon',
          entityId: row.id,
          changes: {
            code: row.code,
            personalFor: input.personalFor,
            discountType: row.discountType,
            discountValue: Number(row.discountValue),
          },
        });
        return this.toDto(row);
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002' || attempt === 4) throw err;
      }
    }
    throw new ConflictException({ code: 'coupon_code_taken', message: 'Inténtalo de nuevo' });
  }

  /**
   * Cupón del recomendado, al día con los ajustes de Referidos. Devuelve su
   * código, o null si el negocio no premia al recomendado. Solo lo aplica la
   * reserva cuando llega un código de referido válido.
   */
  async ensureReferralFriendCoupon(tenantId: string): Promise<string | null> {
    try {
      return await this.syncReferralFriendCoupon(tenantId);
    } catch (err) {
      // Dos reservas a la vez la primera vez: la otra ya lo ha creado.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return this.syncReferralFriendCoupon(tenantId);
    }
  }

  private syncReferralFriendCoupon(tenantId: string): Promise<string | null> {
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          referralEnabled: true,
          referralFriendRewardType: true,
          referralFriendRewardValue: true,
        },
      });
      const type = tenant?.referralFriendRewardType;
      const value = Number(tenant?.referralFriendRewardValue ?? 0);
      const on =
        !!tenant?.referralEnabled && (type === 'percentage' || type === 'fixed') && value > 0;
      const current = await tx.coupon.findFirst({ where: { tenantId, kind: 'referral_friend' } });
      if (!on) {
        if (current?.isActive) {
          await tx.coupon.update({ where: { id: current.id }, data: { isActive: false } });
        }
        return null;
      }
      const data = {
        name: 'Recomendado por un inquilino',
        discountType: type as 'percentage' | 'fixed',
        discountValue: value,
        minMonths: 1,
        newCustomersOnly: true,
        oncePerCustomer: true,
        isActive: true,
      };
      if (current) {
        if (
          current.discountType !== data.discountType ||
          Number(current.discountValue) !== value ||
          !current.isActive
        ) {
          await tx.coupon.update({ where: { id: current.id }, data });
        }
        return current.code;
      }
      const taken = new Set(
        (
          await tx.coupon.findMany({
            where: { tenantId, code: { in: REFERRAL_FRIEND_CODES } },
            select: { code: true },
          })
        ).map((c) => c.code),
      );
      const code = REFERRAL_FRIEND_CODES.find((c) => !taken.has(c)) ?? `AMIGO-${randomCode(4)}`;
      await tx.coupon.create({ data: { tenantId, code, kind: 'referral_friend', ...data } });
      return code;
    }, tenantId);
  }

  /** Cuánto ha descontado y lo que traen al mes los contratos que lo usaron. */
  async results(tenantId: string, id: string): Promise<CouponResultsDto> {
    await this.findOrThrow(tenantId, id);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.couponRedemption.findMany({
          where: { tenantId, couponId: id },
          select: {
            discountAmount: true,
            contract: { select: { status: true, priceMonthly: true, discountAmount: true } },
          },
        }),
      tenantId,
    );
    const live = rows.filter(
      (r) => r.contract && (r.contract.status === 'active' || r.contract.status === 'ending'),
    );
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      uses: rows.length,
      totalDiscount: round(rows.reduce((sum, r) => sum + Number(r.discountAmount), 0)),
      liveContracts: live.length,
      monthlyRevenue: round(
        live.reduce(
          (sum, r) =>
            sum +
            Math.max(0, Number(r.contract!.priceMonthly) - Number(r.contract!.discountAmount)),
          0,
        ),
      ),
    };
  }

  async getSettings(tenantId: string): Promise<CouponSettingsDto> {
    const t = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { bookingRecoveryCouponPct: true, bookingRecoveryCouponDays: true },
        }),
      tenantId,
    );
    return {
      bookingRecoveryCouponPct: t?.bookingRecoveryCouponPct ?? 0,
      bookingRecoveryCouponDays: t?.bookingRecoveryCouponDays ?? 2,
    };
  }

  async updateSettings(
    tenantId: string,
    input: UpdateCouponSettingsInput,
    userId: string | null = null,
  ): Promise<CouponSettingsDto> {
    await this.prisma.withTenant(
      (tx) => tx.tenant.update({ where: { id: tenantId }, data: input }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'coupon.settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: input,
    });
    return this.getSettings(tenantId);
  }

  /** ¿Hay un cupón con ese código? (la reserva online prueba después con una promoción). */
  async exists(tenantId: string, code: string): Promise<boolean> {
    const n = await this.prisma.withTenant(
      (tx) =>
        tx.coupon.count({
          where: { tenantId, code: normalizeCode(code), kind: { not: 'referral_friend' } },
        }),
      tenantId,
    );
    return n > 0;
  }

  async create(
    tenantId: string,
    input: CreateCouponInput,
    userId: string | null = null,
  ): Promise<CouponDto> {
    await this.assertScopeIds(tenantId, input.unitTypeIds, input.facilityIds);
    try {
      const row = await this.prisma.withTenant(
        (tx) =>
          tx.coupon.create({
            data: {
              tenantId,
              code: input.code,
              name: input.name,
              discountType: input.discountType,
              discountValue: input.discountValue,
              minMonths: input.minMonths,
              minAmount: input.minAmount,
              unitTypeIds: input.unitTypeIds,
              facilityIds: input.facilityIds,
              newCustomersOnly: input.newCustomersOnly,
              oncePerCustomer: input.oncePerCustomer,
              preOpeningOnly: input.preOpeningOnly,
              maxUses: input.maxUses,
              validFrom: input.validFrom ? new Date(input.validFrom) : null,
              validUntil: input.validUntil ? new Date(input.validUntil) : null,
              isActive: input.isActive,
              announceOnWeb: input.announceOnWeb,
            },
          }),
        tenantId,
      );
      await this.audit.write({
        tenantId,
        userId,
        action: 'coupon.created',
        entityType: 'Coupon',
        entityId: row.id,
        changes: {
          code: row.code,
          discountType: row.discountType,
          discountValue: Number(row.discountValue),
        },
      });
      return this.toDto(row);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          code: 'coupon_code_taken',
          message: 'Ya existe un cupón con ese código',
        });
      }
      throw err;
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateCouponInput,
    userId: string | null = null,
  ): Promise<CouponDto> {
    const current = await this.findOrThrow(tenantId, id);
    // Las reglas que cruzan campos se comprueban sobre el resultado.
    const merged = {
      discountType: input.discountType ?? current.discountType,
      discountValue: input.discountValue ?? Number(current.discountValue),
      minMonths: input.minMonths ?? current.minMonths,
      validFrom:
        input.validFrom !== undefined
          ? input.validFrom
          : (current.validFrom?.toISOString() ?? null),
      validUntil:
        input.validUntil !== undefined
          ? input.validUntil
          : (current.validUntil?.toISOString() ?? null),
    };
    const issue = couponRuleIssues(merged)[0];
    if (issue) {
      throw new BadRequestException({ code: 'invalid_coupon', message: issue.message });
    }
    await this.assertScopeIds(tenantId, input.unitTypeIds ?? [], input.facilityIds ?? []);

    const data: Prisma.CouponUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.discountType !== undefined) data.discountType = input.discountType;
    if (input.discountValue !== undefined) data.discountValue = input.discountValue;
    if (input.minMonths !== undefined) data.minMonths = input.minMonths;
    if (input.minAmount !== undefined) data.minAmount = input.minAmount;
    if (input.unitTypeIds !== undefined) data.unitTypeIds = input.unitTypeIds;
    if (input.facilityIds !== undefined) data.facilityIds = input.facilityIds;
    if (input.newCustomersOnly !== undefined) data.newCustomersOnly = input.newCustomersOnly;
    if (input.oncePerCustomer !== undefined) data.oncePerCustomer = input.oncePerCustomer;
    if (input.preOpeningOnly !== undefined) data.preOpeningOnly = input.preOpeningOnly;
    if (input.maxUses !== undefined) data.maxUses = input.maxUses;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.announceOnWeb !== undefined) data.announceOnWeb = input.announceOnWeb;
    if (input.validFrom !== undefined)
      data.validFrom = input.validFrom ? new Date(input.validFrom) : null;
    if (input.validUntil !== undefined)
      data.validUntil = input.validUntil ? new Date(input.validUntil) : null;
    const row = await this.prisma.withTenant(
      (tx) => tx.coupon.update({ where: { id }, data }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'coupon.updated',
      entityType: 'Coupon',
      entityId: id,
      changes: { code: current.code, fields: Object.keys(data) },
    });
    return this.toDto(row);
  }

  /** Un cupón ya usado no se borra (se perdería el registro de sus usos): se desactiva. */
  async remove(tenantId: string, id: string, userId: string | null = null): Promise<void> {
    const c = await this.findOrThrow(tenantId, id);
    if (c.usedCount > 0) {
      throw new ConflictException({
        code: 'coupon_in_use',
        message: 'Este cupón ya se ha usado: desactívalo en lugar de borrarlo',
      });
    }
    await this.prisma.withTenant(async (tx) => {
      // Las landings que lo anunciaban dejan de enseñar la oferta (el cupón ya no existe).
      const landings = await tx.promoLanding.findMany({
        where: { tenantId, couponId: id },
        select: { id: true, content: true },
      });
      for (const l of landings) {
        const content = parsePromoLandingContent(l.content);
        content.offer.enabled = false;
        content.promotion.enabled = false;
        await tx.promoLanding.update({
          where: { id: l.id },
          data: { couponId: null, content: content as unknown as Prisma.InputJsonValue },
        });
      }
      await tx.coupon.delete({ where: { id } });
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: 'coupon.deleted',
      entityType: 'Coupon',
      entityId: id,
      changes: { code: c.code },
    });
  }

  async listRedemptions(tenantId: string, id: string): Promise<CouponRedemptionDto[]> {
    await this.findOrThrow(tenantId, id);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.couponRedemption.findMany({
          where: { tenantId, couponId: id },
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: {
            customer: { select: { firstName: true, lastName: true, companyName: true } },
            contract: { select: { contractNumber: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerName: r.customer
        ? r.customer.companyName ||
          [r.customer.firstName, r.customer.lastName].filter(Boolean).join(' ') ||
          null
        : null,
      contractId: r.contractId,
      contractNumber: r.contract?.contractNumber ?? null,
      invoiceId: r.invoiceId,
      months: r.months,
      discountAmount: Number(r.discountAmount),
      freeMonths: r.freeMonths,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Comprueba un cupón para un trastero concreto (alta de contrato en el panel). */
  async validateForUnit(tenantId: string, input: ValidateCouponInput): Promise<CouponQuoteDto> {
    const unit = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findFirst({
          where: { id: input.unitId, tenantId },
          select: {
            unitTypeId: true,
            facilityId: true,
            basePriceMonthly: true,
            facility: { select: { preOpening: true } },
          },
        }),
      tenantId,
    );
    if (!unit) {
      throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
    }
    return this.quote(tenantId, input.code, {
      monthlyPrice: input.monthlyPrice ?? Number(unit.basePriceMonthly),
      // Local por abrir: se paga una mensualidad.
      months: unit.facility.preOpening ? 1 : input.months,
      preOpening: unit.facility.preOpening,
      unitTypeId: unit.unitTypeId,
      facilityId: unit.facilityId,
      isNewCustomer: input.customerId ? await this.isNewCustomer(tenantId, input.customerId) : null,
      usedByCustomer: input.customerId
        ? await this.usedByCustomer(tenantId, input.code, input.customerId)
        : null,
    });
  }

  /** Si el cliente ya usó este cupón en otro contrato. */
  async usedByCustomer(tenantId: string, code: string, customerId: string): Promise<boolean> {
    const n = await this.prisma.withTenant(
      (tx) =>
        tx.couponRedemption.count({
          where: { tenantId, customerId, coupon: { code: normalizeCode(code) } },
        }),
      tenantId,
    );
    return n > 0;
  }

  /** Día desde el que el primer pago mensual incluye el mes siguiente (null = no). */
  async nextMonthFromDay(tenantId: string): Promise<number | null> {
    const t = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { firstPaymentNextMonthFromDay: true },
        }),
      tenantId,
    );
    return t?.firstPaymentNextMonthFromDay ?? null;
  }

  /** Calcula el cupón para un pago, sin reservar el uso. */
  async quote(
    tenantId: string,
    code: string,
    ctx: CouponQuoteContext & { referralFriend?: boolean | undefined },
  ): Promise<CouponQuoteDto> {
    const normalized = normalizeCode(code);
    const coupon = await this.prisma.withTenant(
      (tx) => tx.coupon.findFirst({ where: { tenantId, code: normalized } }),
      tenantId,
    );
    // El cupón del recomendado solo lo aplica la reserva con un código de referido.
    if (!coupon || (coupon.kind === 'referral_friend' && !ctx.referralFriend)) {
      return {
        valid: false,
        reason: 'not_found',
        message: couponRejectMessage('not_found'),
        code: normalized,
        name: null,
      };
    }
    return { ...quoteCoupon(toRules(coupon), ctx), code: coupon.code, name: coupon.name };
  }

  /**
   * Resumen de lo que paga el cliente al contratar: alquiler de los meses
   * elegidos con el cupón (si vale), IVA y fianza. Sin cupón o con uno que no
   * vale, el alquiler va sin descuento y `coupon.message` dice por qué.
   */
  async quoteFirstPayment(
    tenantId: string,
    args: {
      monthlyPrice: number;
      months: number;
      unitTypeId: string;
      facilityId: string;
      propertyKind: string | null | undefined;
      deposit: number;
      couponCode?: string | null | undefined;
      isNewCustomer?: boolean | null | undefined;
      /** Para «un uso por cliente». */
      customerId?: string | null | undefined;
      /** Web pública: sin decir si un código existe. */
      publicMessages?: boolean;
      /** Fecha de entrada (YYYY-MM-DD): el primer pago mensual sale exacto. */
      startDate?: string | null | undefined;
      /** Local por abrir: una mensualidad completa (admite cupones de preapertura). */
      preOpening?: boolean;
      /** El cupón es el del recomendado (lo pone la reserva, no el visitante). */
      referralFriend?: boolean;
    },
  ): Promise<FirstPaymentQuoteDto> {
    const code = args.couponCode?.trim();
    const quote = code
      ? await this.quote(tenantId, code, {
          monthlyPrice: args.monthlyPrice,
          months: args.months,
          unitTypeId: args.unitTypeId,
          facilityId: args.facilityId,
          isNewCustomer: args.isNewCustomer,
          preOpening: !!args.preOpening,
          usedByCustomer: args.customerId
            ? await this.usedByCustomer(tenantId, code, args.customerId)
            : null,
          referralFriend: args.referralFriend,
        })
      : null;
    const result = buildFirstPaymentQuote({
      monthlyPrice: args.monthlyPrice,
      months: args.months,
      vatRate: rentTax(args.propertyKind).taxRate,
      discountAmount: quote?.valid ? quote.discountAmount : 0,
      freeMonths: quote?.valid ? quote.freeMonths : 0,
      deposit: args.deposit,
      prorated: args.months === 1 && !quote?.valid,
      ...(args.preOpening ? { preOpening: true } : {}),
      firstMonth: args.startDate
        ? firstMonthPlan(args.startDate, await this.nextMonthFromDay(tenantId))
        : null,
      coupon: quote
        ? {
            code: quote.code,
            name: quote.name,
            valid: quote.valid,
            message: quote.valid
              ? null
              : args.publicMessages
                ? publicCouponRejectMessage(quote.reason, quote.message)
                : quote.message,
          }
        : null,
    });
    return args.referralFriend && quote?.valid ? { ...result, referralFriend: true } : result;
  }

  /** Cliente nuevo = sin ningún contrato firmado antes. */
  async isNewCustomer(tenantId: string, customerId: string): Promise<boolean> {
    const signed = await this.prisma.withTenant(
      (tx) => tx.contract.count({ where: { tenantId, customerId, ...CUSTOMER_CONTRACT_WHERE } }),
      tenantId,
    );
    return signed === 0;
  }

  /**
   * Comprueba el cupón y reserva un uso DENTRO de la transacción de quien lo
   * aplica (el incremento condicionado evita pasar de `maxUses` con dos usos a
   * la vez). Lanza 400 con el motivo si no vale.
   */
  async redeemInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    code: string,
    ctx: CouponQuoteContext & {
      customerId?: string | null | undefined;
      referralFriend?: boolean | undefined;
    },
  ): Promise<RedeemedCoupon> {
    const normalized = normalizeCode(code);
    const coupon = await tx.coupon.findFirst({ where: { tenantId, code: normalized } });
    if (!coupon || (coupon.kind === 'referral_friend' && !ctx.referralFriend)) {
      throw new BadRequestException({
        code: 'coupon_not_found',
        message: couponRejectMessage('not_found'),
      });
    }
    const usedByCustomer =
      coupon.oncePerCustomer && ctx.customerId
        ? (await tx.couponRedemption.count({
            where: { tenantId, couponId: coupon.id, customerId: ctx.customerId },
          })) > 0
        : null;
    const quote = quoteCoupon(toRules(coupon), { ...ctx, usedByCustomer });
    if (!quote.valid) {
      throw new BadRequestException({ code: `coupon_${quote.reason}`, message: quote.message });
    }
    const claimed = await tx.coupon.updateMany({
      where:
        coupon.maxUses === null
          ? { id: coupon.id, isActive: true }
          : { id: coupon.id, isActive: true, usedCount: { lt: coupon.maxUses } },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new BadRequestException({
        code: 'coupon_max_uses_reached',
        message: couponRejectMessage('max_uses_reached'),
      });
    }
    return { couponId: coupon.id, code: coupon.code, name: coupon.name, quote };
  }

  /** Guarda el uso ya reservado (contrato y factura en los que se aplicó). */
  async recordRedemptionInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    redeemed: RedeemedCoupon,
    refs: { customerId: string | null; contractId: string | null; invoiceId: string | null },
  ): Promise<void> {
    await tx.couponRedemption.create({
      data: {
        tenantId,
        couponId: redeemed.couponId,
        customerId: refs.customerId,
        contractId: refs.contractId,
        invoiceId: refs.invoiceId,
        months: redeemed.quote.months,
        discountAmount: redeemed.quote.discountAmount,
        freeMonths: redeemed.quote.freeMonths,
      },
    });
  }

  /**
   * Libera el cupón de un contrato que se cancela sin haber pagado el primer
   * pago (reserva abandonada, borrador cancelado): borra el uso y devuelve la
   * plaza. Si el primer pago se cobró, el uso se queda.
   */
  async releaseForContractInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    contractId: string,
  ): Promise<void> {
    const use = await tx.couponRedemption.findFirst({
      where: { tenantId, contractId },
      select: {
        id: true,
        couponId: true,
        invoice: { select: { amountPaid: true, status: true } },
      },
    });
    // Si el primer pago se cobró (o era de 0 € y quedó saldado), el uso se queda.
    if (
      !use ||
      (use.invoice &&
        (Number(use.invoice.amountPaid) > 0 ||
          ['paid', 'refunded', 'partially_refunded'].includes(use.invoice.status)))
    ) {
      return;
    }
    await tx.couponRedemption.delete({ where: { id: use.id } });
    await tx.coupon.updateMany({
      where: { id: use.couponId, usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
  }

  private async findOrThrow(tenantId: string, id: string): Promise<CouponRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.coupon.findFirst({ where: { id, tenantId, kind: { not: 'referral_friend' } } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'coupon_not_found', message: 'Cupón no encontrado' });
    }
    return row;
  }

  /** Los tipos y locales del cupón deben ser del tenant. */
  private async assertScopeIds(
    tenantId: string,
    unitTypeIds: string[],
    facilityIds: string[],
  ): Promise<void> {
    if (unitTypeIds.length === 0 && facilityIds.length === 0) return;
    const [types, facilities] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          unitTypeIds.length
            ? tx.unitType.count({ where: { tenantId, id: { in: unitTypeIds } } })
            : Promise.resolve(0),
          facilityIds.length
            ? tx.facility.count({ where: { tenantId, id: { in: facilityIds }, deletedAt: null } })
            : Promise.resolve(0),
        ]),
      tenantId,
    );
    if (types !== new Set(unitTypeIds).size || facilities !== new Set(facilityIds).size) {
      throw new BadRequestException({
        code: 'invalid_scope',
        message: 'Algún tipo de trastero o local no existe',
      });
    }
  }
}
