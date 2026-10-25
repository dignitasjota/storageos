import { randomInt } from 'node:crypto';

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
    rewardInvoice: { select: { invoiceNumber: true } };
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
      reward:
        r.rewardType && r.rewardValue !== null
          ? {
              type: r.rewardType as 'percentage' | 'fixed',
              value: Number(r.rewardValue),
              appliedAt: r.rewardAppliedAt?.toISOString() ?? null,
              invoiceNumber: r.rewardInvoice?.invoiceNumber ?? null,
            }
          : null,
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

      // La recompensa es un descuento en la siguiente factura de quien recomienda
      // (la aplica la facturación recurrente). Antes era un código de promoción
      // que solo valía al crear un contrato nuevo: un cliente no podía usarlo.
      const rewardValue = Number(tenant.referralRewardValue);
      const hasReward = rewardValue > 0 && tenant.referralRewardType !== 'free_months';
      await this.admin.referral.update({
        where: { id: referral.id },
        data: {
          status: 'converted',
          convertedAt: new Date(),
          ...(hasReward ? { rewardType: tenant.referralRewardType, rewardValue } : {}),
        },
      });
      this.logger.log(
        `[referrals] convertido referral ${referral.id}${hasReward ? ' + recompensa' : ''}`,
      );
    } catch (err) {
      this.logger.error(
        `[referrals] conversión falló para customer ${customerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Recompensas pendientes de quien recomienda, para la factura de su contrato:
   * las reserva (marca aplicadas) y devuelve el descuento a restar de la cuota.
   * Un porcentaje se calcula sobre la cuota de esa factura; el importe fijo, con
   * tope en la cuota (lo que no cabe se queda para la siguiente).
   */
  async claimRewardsForInvoice(
    tenantId: string,
    customerId: string,
    rentAmount: number,
  ): Promise<{ referralIds: string[]; discount: number }> {
    if (rentAmount <= 0) return { referralIds: [], discount: 0 };
    const pending = await this.admin.referral.findMany({
      where: {
        tenantId,
        referrerCustomerId: customerId,
        status: 'converted',
        rewardAppliedAt: null,
        rewardValue: { not: null },
      },
      orderBy: { convertedAt: 'asc' },
      select: { id: true, rewardType: true, rewardValue: true },
    });
    const ids: string[] = [];
    let discountCents = 0;
    const rentCents = Math.round(rentAmount * 100);
    for (const p of pending) {
      const value = Number(p.rewardValue);
      const cents =
        p.rewardType === 'percentage'
          ? Math.round((rentCents * value) / 100)
          : Math.round(value * 100);
      if (cents <= 0 || discountCents + cents > rentCents) continue;
      // Reserva atómica: con dos contratos a la vez, solo uno la aplica.
      const claimed = await this.admin.referral.updateMany({
        where: { id: p.id, rewardAppliedAt: null },
        data: { rewardAppliedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      ids.push(p.id);
      discountCents += cents;
    }
    return { referralIds: ids, discount: discountCents / 100 };
  }

  /** Enlaza las recompensas a la factura que las aplicó, o las libera si falló. */
  async settleRewards(referralIds: string[], invoiceId: string | null): Promise<void> {
    if (referralIds.length === 0) return;
    await this.admin.referral.updateMany({
      where: { id: { in: referralIds } },
      data: invoiceId ? { rewardInvoiceId: invoiceId } : { rewardAppliedAt: null },
    });
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
            rewardInvoice: { select: { invoiceNumber: true } },
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
            rewardInvoice: { select: { invoiceNumber: true } },
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
      rewards: referrals.flatMap((r): PortalReferralDto['rewards'] => {
        if (r.rewardType && r.rewardValue !== null) {
          return [
            {
              type: r.rewardType as 'percentage' | 'fixed',
              value: Number(r.rewardValue),
              appliedAt: r.rewardAppliedAt?.toISOString() ?? null,
              invoiceNumber: r.rewardInvoice?.invoiceNumber ?? null,
              code: null,
            },
          ];
        }
        // Recompensas antiguas: códigos de promoción.
        return r.rewardPromotion?.code
          ? [
              {
                type: 'fixed' as const,
                value: 0,
                appliedAt: null,
                invoiceNumber: null,
                code: r.rewardPromotion.code,
              },
            ]
          : [];
      }),
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
