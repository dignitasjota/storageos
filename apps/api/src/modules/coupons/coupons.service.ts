import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  couponRejectMessage,
  couponRuleIssues,
  quoteCoupon,
  type CouponDto,
  type CouponQuote,
  type CouponQuoteContext,
  type CouponQuoteDto,
  type CouponRedemptionDto,
  type CouponRules,
  type CreateCouponInput,
  type UpdateCouponInput,
  type ValidateCouponInput,
} from '@storageos/shared';

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
    maxUses: c.maxUses,
    usedCount: c.usedCount,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    isActive: c.isActive,
  };
}

const normalizeCode = (code: string): string => code.trim().toUpperCase();

/**
 * Cupones: descuento sobre el pago que se hace en ese momento (no sobre las
 * renovaciones). El cálculo es `quoteCoupon` (shared, también lo usa la web);
 * aquí se cargan los datos, se reserva el uso y se guarda cada aplicación.
 */
@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

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
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      validFrom: c.validFrom?.toISOString() ?? null,
      validUntil: c.validUntil?.toISOString() ?? null,
      isActive: c.isActive,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async list(tenantId: string): Promise<CouponDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.coupon.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(tenantId: string, input: CreateCouponInput): Promise<CouponDto> {
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
              maxUses: input.maxUses,
              validFrom: input.validFrom ? new Date(input.validFrom) : null,
              validUntil: input.validUntil ? new Date(input.validUntil) : null,
              isActive: input.isActive,
            },
          }),
        tenantId,
      );
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

  async update(tenantId: string, id: string, input: UpdateCouponInput): Promise<CouponDto> {
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
    if (input.maxUses !== undefined) data.maxUses = input.maxUses;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.validFrom !== undefined)
      data.validFrom = input.validFrom ? new Date(input.validFrom) : null;
    if (input.validUntil !== undefined)
      data.validUntil = input.validUntil ? new Date(input.validUntil) : null;
    const row = await this.prisma.withTenant(
      (tx) => tx.coupon.update({ where: { id }, data }),
      tenantId,
    );
    return this.toDto(row);
  }

  /** Un cupón ya usado no se borra (se perdería el registro de sus usos): se desactiva. */
  async remove(tenantId: string, id: string): Promise<void> {
    const c = await this.findOrThrow(tenantId, id);
    if (c.usedCount > 0) {
      throw new ConflictException({
        code: 'coupon_in_use',
        message: 'Este cupón ya se ha usado: desactívalo en lugar de borrarlo',
      });
    }
    await this.prisma.withTenant((tx) => tx.coupon.delete({ where: { id } }), tenantId);
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
          select: { unitTypeId: true, facilityId: true, basePriceMonthly: true },
        }),
      tenantId,
    );
    if (!unit) {
      throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
    }
    return this.quote(tenantId, input.code, {
      monthlyPrice: input.monthlyPrice ?? Number(unit.basePriceMonthly),
      months: input.months,
      unitTypeId: unit.unitTypeId,
      facilityId: unit.facilityId,
      isNewCustomer: input.customerId ? await this.isNewCustomer(tenantId, input.customerId) : null,
    });
  }

  /** Calcula el cupón para un pago, sin reservar el uso. */
  async quote(tenantId: string, code: string, ctx: CouponQuoteContext): Promise<CouponQuoteDto> {
    const normalized = normalizeCode(code);
    const coupon = await this.prisma.withTenant(
      (tx) => tx.coupon.findFirst({ where: { tenantId, code: normalized } }),
      tenantId,
    );
    if (!coupon) {
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

  /** Cliente nuevo = sin ningún contrato firmado antes. */
  async isNewCustomer(tenantId: string, customerId: string): Promise<boolean> {
    const signed = await this.prisma.withTenant(
      (tx) => tx.contract.count({ where: { tenantId, customerId, signedAt: { not: null } } }),
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
    ctx: CouponQuoteContext,
  ): Promise<RedeemedCoupon> {
    const normalized = normalizeCode(code);
    const coupon = await tx.coupon.findFirst({ where: { tenantId, code: normalized } });
    if (!coupon) {
      throw new BadRequestException({
        code: 'coupon_not_found',
        message: couponRejectMessage('not_found'),
      });
    }
    const quote = quoteCoupon(toRules(coupon), ctx);
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
      select: { id: true, couponId: true, invoice: { select: { amountPaid: true } } },
    });
    if (!use || (use.invoice && Number(use.invoice.amountPaid) > 0)) return;
    await tx.couponRedemption.delete({ where: { id: use.id } });
    await tx.coupon.updateMany({
      where: { id: use.couponId, usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
  }

  private async findOrThrow(tenantId: string, id: string): Promise<CouponRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.coupon.findFirst({ where: { id, tenantId } }),
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
