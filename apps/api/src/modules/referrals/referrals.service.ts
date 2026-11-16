import { randomInt } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { customerScopeWhere } from '../../common/customer-scope';
import { formatEur } from '../../common/format';
import {
  type BookingExpiredPayload,
  DOMAIN_EVENTS,
  type DomainEventPayload,
} from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { FacilityScope } from '../../common/facility-scope';
import type { Prisma } from '@storageos/database';
import type {
  CustomerReferralCodeDto,
  PortalReferralDto,
  ReferralDto,
  ReferralStatsDto,
} from '@storageos/shared';

/** Formas de pago que no son dinero que entra (no dan por pagado al recomendado). */
const NOT_MONEY = ['credit_note', 'withholding', 'deposit'] as const;

/** Lo que una factura descuenta de una recompensa (para enlazarla o devolverla). */
export interface RewardClaim {
  referralId: string;
  /** Céntimos descontados en esta factura. */
  cents: number;
  /** Céntimos que llevaba descontados antes (recompensa fija repartida). */
  previousCents: number;
}

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
      select: {
        firstName: true;
        lastName: true;
        companyName: true;
        customerType: true;
        contracts: { select: { id: true } };
      };
    };
    referred: {
      select: { firstName: true; lastName: true; companyName: true; customerType: true };
    };
    rewardPromotion: { select: { code: true } };
    rewardInvoice: { select: { invoiceNumber: true } };
  };
}>;

const REFERRAL_INCLUDE = {
  referrer: {
    select: {
      firstName: true,
      lastName: true,
      companyName: true,
      customerType: true,
      // ¿Sigue siendo inquilino? Sin contrato en vigor no hay factura donde descontar.
      contracts: {
        where: { deletedAt: null, status: { in: ['active', 'ending'] } },
        select: { id: true },
        take: 1,
      },
    },
  },
  referred: {
    select: { firstName: true, lastName: true, companyName: true, customerType: true },
  },
  rewardPromotion: { select: { code: true } },
  rewardInvoice: { select: { invoiceNumber: true } },
} satisfies Prisma.ReferralInclude;

/** Referidos que ve quien solo tiene unos locales: los dos inquilinos a su alcance. */
function referralScopeWhere(scope: FacilityScope): Prisma.ReferralWhereInput {
  if (!scope) return {};
  return { referrer: customerScopeWhere(scope), referred: customerScopeWhere(scope) };
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
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
              appliedAmount: Number(r.rewardAppliedAmount),
              appliedAt: r.rewardAppliedAt?.toISOString() ?? null,
              invoiceNumber: r.rewardInvoice?.invoiceNumber ?? null,
            }
          : null,
      referrerActive: r.referrer.contracts.length > 0,
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
      // Con el programa apagado no se registra nada (quedaría pendiente para siempre).
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { referralEnabled: true },
      });
      if (!tenant?.referralEnabled) return;
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
  // Conversión + recompensa (cuando el recomendado paga su primera factura)
  // ---------------------------------------------------------------------

  /**
   * La recompensa se gana cuando el recomendado PAGA, no al firmar: una reserva
   * online se firma gratis y, sin pago, caduca sola a los pocos días.
   */
  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    const customerId = payload.customerId;
    if (!customerId || payload.entityType !== 'invoice') return;
    try {
      const referral = await this.admin.referral.findFirst({
        where: {
          tenantId: payload.tenantId,
          referredCustomerId: customerId,
          status: { in: ['pending', 'cancelled'] },
        },
      });
      if (!referral) return;
      // Dinero de verdad en una factura de su contrato (no un abono, una
      // retención ni una factura de 0 € saldada sola).
      const paid = await this.admin.payment.findFirst({
        where: {
          tenantId: payload.tenantId,
          invoiceId: payload.entityId,
          status: { in: ['succeeded', 'partially_refunded'] },
          amount: { gt: 0 },
          methodType: { notIn: [...NOT_MONEY] },
          invoice: { customerId, kind: 'invoice', contractId: { not: null } },
        },
        select: { id: true },
      });
      if (!paid) return;
      const tenant = await this.admin.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { referralEnabled: true, referralRewardType: true, referralRewardValue: true },
      });
      if (!tenant?.referralEnabled) return;

      // La recompensa es un descuento en las siguientes facturas de quien
      // recomienda (lo aplica la facturación recurrente).
      const rewardValue = Number(tenant.referralRewardValue);
      const hasReward = rewardValue > 0 && tenant.referralRewardType !== 'free_months';
      // Reserva atómica: dos pagos a la vez no la conceden dos veces.
      const converted = await this.admin.referral.updateMany({
        where: { id: referral.id, status: { in: ['pending', 'cancelled'] } },
        data: {
          status: 'converted',
          convertedAt: new Date(),
          ...(hasReward ? { rewardType: tenant.referralRewardType, rewardValue } : {}),
        },
      });
      if (converted.count === 0) return;
      this.logger.log(
        `[referrals] convertido referral ${referral.id}${hasReward ? ' + recompensa' : ''}`,
      );
      const reward = hasReward
        ? tenant.referralRewardType === 'percentage'
          ? `un ${rewardValue} % de su cuota`
          : formatEur(rewardValue)
        : null;
      await this.notifyStaff(payload.tenantId, referral, reward);
      if (hasReward) {
        await this.notifyReferrer(
          payload.tenantId,
          referral.referrerCustomerId,
          customerId,
          tenant.referralRewardType === 'percentage'
            ? `un ${rewardValue} % de tu cuota`
            : formatEur(rewardValue),
        );
      }
    } catch (err) {
      this.logger.error(
        `[referrals] conversión falló para customer ${customerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** El recomendado se quedó sin contrato antes de pagar: su referido no llegó a nada. */
  @OnEvent(DOMAIN_EVENTS.booking_expired, { async: true, promisify: true })
  async onBookingExpired(payload: BookingExpiredPayload): Promise<void> {
    await this.cancelIfGone(payload.tenantId, payload.customerId);
  }

  @OnEvent(DOMAIN_EVENTS.contract_ended, { async: true, promisify: true })
  async onContractEnded(payload: DomainEventPayload): Promise<void> {
    if (payload.customerId) await this.cancelIfGone(payload.tenantId, payload.customerId);
  }

  /**
   * Un referido pendiente cuyo recomendado ya no tiene ningún contrato en
   * marcha pasa a «cancelado». Si vuelve y paga, se convierte igualmente.
   */
  private async cancelIfGone(tenantId: string, referredId: string): Promise<void> {
    try {
      const live = await this.admin.contract.count({
        where: {
          tenantId,
          customerId: referredId,
          deletedAt: null,
          status: { in: ['draft', 'active', 'ending'] },
        },
      });
      if (live > 0) return;
      await this.admin.referral.updateMany({
        where: { tenantId, referredCustomerId: referredId, status: 'pending' },
        data: { status: 'cancelled' },
      });
    } catch (err) {
      this.logger.warn(
        `[referrals] no se pudo cancelar el referido de ${referredId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Aviso al equipo: un referido ya es cliente (y qué recompensa se lleva quien recomendó). */
  private async notifyStaff(
    tenantId: string,
    referral: { referrerCustomerId: string; referredCustomerId: string },
    reward: string | null,
  ): Promise<void> {
    try {
      const people = await this.admin.customer.findMany({
        where: {
          tenantId,
          id: { in: [referral.referrerCustomerId, referral.referredCustomerId] },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
        },
      });
      const nameOf = (id: string) => {
        const c = people.find((x) => x.id === id);
        return c ? displayName(c) : 'Un inquilino';
      };
      await this.notifications.create(tenantId, {
        type: 'referral.converted',
        title: `${nameOf(referral.referredCustomerId)} ya es cliente por una recomendación`,
        body: reward
          ? `Le recomendó ${nameOf(referral.referrerCustomerId)}, que tendrá ${reward} de descuento en su próxima factura.`
          : `Le recomendó ${nameOf(referral.referrerCustomerId)}.`,
        link: '/referrals',
      });
    } catch (err) {
      this.logger.warn(
        `[referrals] aviso al equipo falló: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Correo al que recomendó: su recomendado ya es cliente y se lleva la recompensa. */
  private async notifyReferrer(
    tenantId: string,
    referrerId: string,
    referredId: string,
    reward: string,
  ): Promise<void> {
    try {
      const [tenant, referrer, referred] = await Promise.all([
        this.admin.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        this.admin.customer.findFirst({
          where: { id: referrerId, tenantId, deletedAt: null },
          select: { email: true, firstName: true, companyName: true },
        }),
        this.admin.customer.findFirst({
          where: { id: referredId, tenantId },
          select: { firstName: true, companyName: true },
        }),
      ]);
      if (!referrer?.email || !tenant) return;
      const hello = referrer.firstName ?? referrer.companyName ?? '';
      const who = referred?.firstName ?? referred?.companyName ?? 'La persona que nos recomendaste';
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: referrer.email,
        subject: `¡Gracias por recomendarnos! Tienes ${reward} de descuento`,
        bodyText: `Hola${hello ? ` ${hello}` : ''},\n\n${who} ya es cliente de ${tenant.name} gracias a tu recomendación. Como agradecimiento, te descontaremos ${reward} en tu próxima factura.\n\nGracias por confiar en nosotros,\nEl equipo de ${tenant.name}`,
        customerId: referrerId,
        source: 'referrals.reward',
      });
    } catch (err) {
      this.logger.warn(
        `[referrals] aviso al que recomendó falló: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Recompensas pendientes de quien recomienda, para la factura de su contrato:
   * las reserva y devuelve el descuento a restar de la cuota. Un porcentaje se
   * calcula sobre la cuota de esa factura y va entero (si no cabe, espera a la
   * siguiente). El importe fijo se reparte: lo que no cabe en esta factura se
   * descuenta en las siguientes.
   */
  async claimRewardsForInvoice(
    tenantId: string,
    customerId: string,
    rentAmount: number,
  ): Promise<{ claims: RewardClaim[]; discount: number }> {
    if (rentAmount <= 0) return { claims: [], discount: 0 };
    const pending = await this.admin.referral.findMany({
      where: {
        tenantId,
        referrerCustomerId: customerId,
        status: 'converted',
        rewardAppliedAt: null,
        rewardValue: { not: null },
      },
      orderBy: { convertedAt: 'asc' },
      select: { id: true, rewardType: true, rewardValue: true, rewardAppliedAmount: true },
    });
    const claims: RewardClaim[] = [];
    let discountCents = 0;
    const rentCents = Math.round(rentAmount * 100);
    for (const p of pending) {
      const room = rentCents - discountCents;
      if (room <= 0) break;
      const valueCents = Math.round(Number(p.rewardValue) * 100);
      const previousCents = Math.round(Number(p.rewardAppliedAmount) * 100);
      const now = new Date();
      if (p.rewardType === 'percentage') {
        const cents = Math.round((rentCents * Math.min(100, Number(p.rewardValue))) / 100);
        if (cents <= 0 || cents > room) continue;
        // Reserva atómica: con dos contratos a la vez, solo uno la aplica.
        const claimed = await this.admin.referral.updateMany({
          where: { id: p.id, rewardAppliedAt: null },
          data: { rewardAppliedAt: now, rewardAppliedAmount: cents / 100 },
        });
        if (claimed.count === 0) continue;
        claims.push({ referralId: p.id, cents, previousCents: 0 });
        discountCents += cents;
        continue;
      }
      const remaining = valueCents - previousCents;
      const cents = Math.min(remaining, room);
      if (cents <= 0) continue;
      const claimed = await this.admin.referral.updateMany({
        where: { id: p.id, rewardAppliedAt: null, rewardAppliedAmount: previousCents / 100 },
        data: {
          rewardAppliedAmount: (previousCents + cents) / 100,
          ...(cents === remaining ? { rewardAppliedAt: now } : {}),
        },
      });
      if (claimed.count === 0) continue;
      claims.push({ referralId: p.id, cents, previousCents });
      discountCents += cents;
    }
    return { claims, discount: discountCents / 100 };
  }

  /** Enlaza las recompensas a la factura que las aplicó, o las devuelve si falló. */
  async settleRewards(claims: RewardClaim[], invoiceId: string | null): Promise<void> {
    if (claims.length === 0) return;
    if (invoiceId) {
      await this.admin.referral.updateMany({
        where: { id: { in: claims.map((c) => c.referralId) } },
        data: { rewardInvoiceId: invoiceId },
      });
      return;
    }
    for (const c of claims) {
      await this.admin.referral.updateMany({
        where: { id: c.referralId },
        data: { rewardAppliedAt: null, rewardAppliedAmount: c.previousCents / 100 },
      });
    }
  }

  // ---------------------------------------------------------------------
  // Lectura (panel staff)
  // ---------------------------------------------------------------------

  async list(tenantId: string, scope: FacilityScope = null): Promise<ReferralDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.referral.findMany({
          where: { tenantId, ...referralScopeWhere(scope) },
          include: REFERRAL_INCLUDE,
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async stats(tenantId: string, scope: FacilityScope = null): Promise<ReferralStatsDto> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.referral.findMany({
          where: { tenantId, ...referralScopeWhere(scope) },
          select: { status: true },
        }),
      tenantId,
    );
    return {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'pending').length,
      converted: rows.filter((r) => r.status === 'converted').length,
    };
  }

  /** Código de un inquilino para dárselo en mano (lo crea si aún no tiene). */
  async codeForStaff(tenantId: string, customerId: string): Promise<CustomerReferralCodeDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { referralEnabled: true },
    });
    if (!tenant?.referralEnabled) return { enabled: false, referralCode: null };
    return { enabled: true, referralCode: await this.ensureCode(tenantId, customerId) };
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
              appliedAmount: Number(r.rewardAppliedAmount),
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
                appliedAmount: 0,
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
