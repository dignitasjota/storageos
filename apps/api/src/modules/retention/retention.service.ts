import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';

import type { RequestMeta } from '../auth/auth.service';
import type { RetentionOffer } from '@storageos/database';
import type {
  CreateRetentionOfferInput,
  PortalRetentionOfferDto,
  RetentionOfferDto,
  RetentionOfferStatus,
} from '@storageos/shared';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Descuento mensual (€) que aplica la oferta sobre una cuota dada. */
function discountAmountFor(
  discountType: string,
  discountValue: number,
  priceMonthly: number,
): number {
  const raw = discountType === 'percentage' ? (priceMonthly * discountValue) / 100 : discountValue;
  return Math.min(Math.round(raw * 100) / 100, priceMonthly);
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async createOffer(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: CreateRetentionOfferInput;
    meta: RequestMeta;
  }): Promise<RetentionOfferDto> {
    const { tenantId, input } = args;
    const created = await this.prisma.withTenant(async (tx) => {
      const contract = await tx.contract.findFirst({
        where: { id: args.contractId, tenantId, deletedAt: null },
        include: { customer: { select: { email: true } }, unit: { select: { code: true } } },
      });
      if (!contract) {
        throw new NotFoundException({
          code: 'contract_not_found',
          message: 'Contrato no encontrado',
        });
      }
      // La retención solo tiene sentido sobre una baja en curso.
      if (contract.status !== 'ending') {
        throw new BadRequestException({
          code: 'contract_not_ending',
          message: 'Solo puedes ofrecer retención sobre una baja en curso',
        });
      }
      const validUntil = new Date(Date.now() + (input.validDays ?? 7) * 86_400_000);
      const row = await tx.retentionOffer.create({
        data: {
          tenantId,
          contractId: args.contractId,
          customerId: contract.customerId,
          discountType: input.discountType,
          discountValue: input.discountValue,
          months: input.months,
          message: input.message?.trim() || null,
          status: 'pending',
          validUntil,
          createdByUserId: args.userId,
        },
      });
      return { row, email: contract.customer.email, unitCode: contract.unit.code };
    }, tenantId);

    // Aviso al inquilino (best-effort).
    if (created.email) {
      const desc =
        input.discountType === 'percentage'
          ? `${input.discountValue}% de descuento`
          : `${input.discountValue} € de descuento`;
      await this.email
        .sendRendered({
          to: created.email,
          subject: 'Una oferta para que te quedes con nosotros',
          html: `<p>Hemos visto que ibas a darte de baja del trastero <strong>${escapeHtml(
            created.unitCode,
          )}</strong>. Nos gustaría que te quedaras: te ofrecemos <strong>${desc}</strong> durante ${input.months} mes(es).</p><p>Entra en tu portal para aceptarla.</p>`,
          text: `Te ofrecemos ${desc} durante ${input.months} mes(es) en el trastero ${created.unitCode} para que te quedes. Entra en tu portal para aceptarla.`,
        })
        .catch((err: unknown) =>
          this.logger.warn(`[retention] email falló: ${err instanceof Error ? err.message : err}`),
        );
    }

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'retention.offer_created',
      entityType: 'RetentionOffer',
      entityId: created.row.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created.row);
  }

  async listForContract(tenantId: string, contractId: string): Promise<RetentionOfferDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.retentionOffer.findMany({ where: { contractId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Ofertas pendientes y vigentes del inquilino (portal). */
  async listForCustomer(tenantId: string, customerId: string): Promise<PortalRetentionOfferDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.retentionOffer.findMany({
          where: { customerId, status: 'pending' },
          orderBy: { createdAt: 'desc' },
          include: {
            contract: { select: { priceMonthly: true, unit: { select: { code: true } } } },
          },
        }),
      tenantId,
    );
    const now = Date.now();
    return rows
      .filter((r) => !r.validUntil || r.validUntil.getTime() >= now)
      .map((r) => {
        const price = Number(r.contract.priceMonthly);
        const disc = discountAmountFor(r.discountType, Number(r.discountValue), price);
        return {
          ...this.toDto(r),
          unitCode: r.contract.unit.code,
          currentPriceMonthly: price,
          discountedPriceMonthly: Math.round((price - disc) * 100) / 100,
        };
      });
  }

  /** El inquilino acepta: revierte la baja y aplica el descuento a su cuota. */
  async acceptByCustomer(args: {
    tenantId: string;
    customerId: string;
    offerId: string;
  }): Promise<{ accepted: true }> {
    await this.prisma.withTenant(async (tx) => {
      const offer = await tx.retentionOffer.findFirst({
        where: { id: args.offerId, customerId: args.customerId, status: 'pending' },
        include: { contract: { select: { id: true, status: true, priceMonthly: true } } },
      });
      if (!offer) {
        throw new NotFoundException({ code: 'offer_not_found', message: 'Oferta no encontrada' });
      }
      if (offer.validUntil && offer.validUntil.getTime() < Date.now()) {
        throw new BadRequestException({ code: 'offer_expired', message: 'La oferta ha caducado' });
      }
      const disc = discountAmountFor(
        offer.discountType,
        Number(offer.discountValue),
        Number(offer.contract.priceMonthly),
      );
      // Revierte la baja (si seguía en curso) y aplica el descuento recurrente.
      await tx.contract.update({
        where: { id: offer.contractId },
        data: {
          ...(offer.contract.status === 'ending'
            ? { status: 'active', endDate: null, endingRequestedAt: null }
            : {}),
          discountAmount: disc,
          discountReason: `Retención: oferta ${offer.id}`,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: offer.contractId,
          eventType: 'resumed',
          payload: { channel: 'portal', reason: 'retention_offer_accepted', offerId: offer.id },
          createdByUserId: null,
        },
      });
      await tx.retentionOffer.update({
        where: { id: offer.id },
        data: { status: 'accepted', respondedAt: new Date() },
      });
    }, args.tenantId);
    return { accepted: true };
  }

  async declineByCustomer(args: {
    tenantId: string;
    customerId: string;
    offerId: string;
  }): Promise<{ declined: true }> {
    await this.prisma.withTenant(async (tx) => {
      const offer = await tx.retentionOffer.findFirst({
        where: { id: args.offerId, customerId: args.customerId, status: 'pending' },
      });
      if (!offer) {
        throw new NotFoundException({ code: 'offer_not_found', message: 'Oferta no encontrada' });
      }
      await tx.retentionOffer.update({
        where: { id: offer.id },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, args.tenantId);
    return { declined: true };
  }

  private toDto(r: RetentionOffer): RetentionOfferDto {
    return {
      id: r.id,
      contractId: r.contractId,
      customerId: r.customerId,
      discountType: r.discountType as 'percentage' | 'fixed',
      discountValue: Number(r.discountValue),
      months: r.months,
      message: r.message,
      status: r.status as RetentionOfferStatus,
      validUntil: r.validUntil?.toISOString() ?? null,
      respondedAt: r.respondedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
