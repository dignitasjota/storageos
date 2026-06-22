import { randomBytes, randomInt } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { PortalReferralDto, ReferralDto, ReferralStatsDto } from '@storageos/shared';

// Sin caracteres ambiguos (0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genShareCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function displayName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

type ReferralRow = Prisma.ReferralGetPayload<{
  include: {
    referrer: {
      select: { firstName: true; lastName: true; companyName: true; customerType: true };
    };
    referred: {
      select: { firstName: true; lastName: true; companyName: true; customerType: true };
    };
    rewardPromotion: { select: { code: true } };
  };
}>;

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  private toDto(r: ReferralRow): ReferralDto {
    return {
      id: r.id,
      referrerCustomerId: r.referrerCustomerId,
      referrerName: displayName(r.referrer),
      referredCustomerId: r.referredCustomerId,
      referredName: displayName(r.referred),
      status: r.status as ReferralDto['status'],
      rewardCode: r.rewardPromotion?.code ?? null,
      createdAt: r.createdAt.toISOString(),
      convertedAt: r.convertedAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------
  // Registro (en el alta de cliente) — best-effort
  // ---------------------------------------------------------------------

  /**
   * Registra un referido DENTRO de la transacción del alta de cliente. Si el
   * código no existe o es del propio cliente, no hace nada (best-effort: nunca
   * bloquea el alta). El referral queda `pending` hasta que el referido firme.
   */
  async registerInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    referralCode: string,
    newCustomerId: string,
  ): Promise<void> {
    try {
      const code = referralCode.trim().toUpperCase();
      if (!code) return;
      const referrer = await tx.customer.findFirst({
        where: { tenantId, referralCode: code, deletedAt: null },
        select: { id: true },
      });
      if (!referrer || referrer.id === newCustomerId) return;
      await tx.referral.create({
        data: {
          tenantId,
          referrerCustomerId: referrer.id,
          referredCustomerId: newCustomerId,
          status: 'pending',
        },
      });
    } catch (err) {
      // Unique (referido ya tenía referral) u otro: best-effort, no romper alta.
      this.logger.warn(
        `[referrals] registro best-effort falló: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Conversión + recompensa (al firmar el primer contrato del referido)
  // ---------------------------------------------------------------------

  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(payload: DomainEventPayload): Promise<void> {
    const customerId = payload.customerId;
    if (!customerId) return;
    try {
      const referral = await this.admin.referral.findFirst({
        where: { tenantId: payload.tenantId, referredCustomerId: customerId, status: 'pending' },
      });
      if (!referral) return;
      const tenant = await this.admin.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { referralEnabled: true, referralRewardType: true, referralRewardValue: true },
      });
      if (!tenant?.referralEnabled) return;

      const rewardValue = Number(tenant.referralRewardValue);
      let rewardPromotionId: string | null = null;
      if (rewardValue > 0 && tenant.referralRewardType !== 'free_months') {
        const promo = await this.createRewardPromotion(
          payload.tenantId,
          tenant.referralRewardType,
          rewardValue,
        );
        rewardPromotionId = promo.id;
      }

      await this.admin.referral.update({
        where: { id: referral.id },
        data: { status: 'converted', convertedAt: new Date(), rewardPromotionId },
      });
      this.logger.log(
        `[referrals] convertido referral ${referral.id}${rewardPromotionId ? ' + recompensa' : ''}`,
      );
    } catch (err) {
      this.logger.error(
        `[referrals] conversión falló para customer ${customerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async createRewardPromotion(
    tenantId: string,
    type: 'percentage' | 'fixed',
    value: number,
  ): Promise<{ id: string }> {
    // Reintenta ante colisión de código (improbable).
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = `REF-${randomBytes(4).toString('hex').toUpperCase()}`;
      try {
        return await this.admin.promotion.create({
          data: {
            tenantId,
            code,
            name: 'Recompensa por referido',
            discountType: type,
            discountValue: value,
            maxUses: 1,
            isActive: true,
          },
          select: { id: true },
        });
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
    throw new Error('no se pudo generar el código de recompensa');
  }

  // ---------------------------------------------------------------------
  // Lectura (panel staff)
  // ---------------------------------------------------------------------

  async list(tenantId: string): Promise<ReferralDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.referral.findMany({
          where: { tenantId },
          include: {
            referrer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            referred: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            rewardPromotion: { select: { code: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async stats(tenantId: string): Promise<ReferralStatsDto> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.referral.findMany({ where: { tenantId }, select: { status: true } }),
      tenantId,
    );
    return {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'pending').length,
      converted: rows.filter((r) => r.status === 'converted').length,
    };
  }

  // ---------------------------------------------------------------------
  // Portal del inquilino
  // ---------------------------------------------------------------------

  async getPortalView(tenantId: string, customerId: string): Promise<PortalReferralDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { referralEnabled: true },
    });
    if (!tenant?.referralEnabled) {
      return { enabled: false, referralCode: null, referrals: [], rewards: [] };
    }
    const referralCode = await this.ensureCode(tenantId, customerId);
    const referrals = await this.prisma.withTenant(
      (tx) =>
        tx.referral.findMany({
          where: { tenantId, referrerCustomerId: customerId },
          include: {
            referred: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            rewardPromotion: { select: { code: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return {
      enabled: true,
      referralCode,
      referrals: referrals.map((r) => ({
        referredName: displayName(r.referred),
        status: r.status as PortalReferralDto['referrals'][number]['status'],
        createdAt: r.createdAt.toISOString(),
      })),
      rewards: referrals.map((r) => r.rewardPromotion?.code).filter((c): c is string => Boolean(c)),
    };
  }

  /** Devuelve el código de referido del cliente, generándolo si no tiene. */
  async ensureCode(tenantId: string, customerId: string): Promise<string> {
    const existing = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { referralCode: true },
    });
    if (existing?.referralCode) return existing.referralCode;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = genShareCode();
      try {
        await this.admin.customer.update({
          where: { id: customerId },
          data: { referralCode: code },
        });
        return code;
      } catch (err) {
        if (attempt === 5) throw err;
      }
    }
    throw new Error('no se pudo generar el código de referido');
  }
}
