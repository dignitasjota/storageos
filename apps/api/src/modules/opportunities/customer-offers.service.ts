import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OPPORTUNITY_LABELS,
  type CustomerOfferStatus,
  type OpportunityKind,
  type PortalOfferDto,
  type PortalRespondOfferInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

const DAY = 86_400_000;
/** Lo que dura una propuesta en el área de clientes. */
const OFFER_DAYS = 30;
const LIVE: CustomerOfferStatus[] = ['open', 'interested'];

/**
 * Propuestas al inquilino (desde Oportunidades). Se enseñan en su área de
 * clientes; él responde «Me interesa» o «No, gracias» y se dan por aceptadas
 * cuando contrata lo propuesto. Nunca se aplica nada solo.
 */
@Injectable()
export class CustomerOffersService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Crea la propuesta (sustituye a la anterior del mismo tipo aún viva). */
  async create(args: {
    tenantId: string;
    customerId: string;
    kind: OpportunityKind;
    message: string;
    priceGross: number | null;
    userId: string | null;
  }): Promise<string> {
    await this.admin.customerOffer.updateMany({
      where: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        kind: args.kind,
        status: { in: LIVE },
      },
      data: { status: 'expired' },
    });
    const row = await this.admin.customerOffer.create({
      data: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        kind: args.kind,
        title: OPPORTUNITY_LABELS[args.kind],
        message: args.message,
        priceGross: args.priceGross,
        expiresAt: new Date(Date.now() + OFFER_DAYS * DAY),
        createdByUserId: args.userId,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Último estado de las propuestas, por `<customerId>:<kind>` (para Oportunidades). */
  async lastStatusByCustomerKind(tenantId: string): Promise<Map<string, CustomerOfferStatus>> {
    await this.expireDue(tenantId);
    const rows = await this.admin.customerOffer.findMany({
      where: { tenantId },
      select: { customerId: true, kind: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const out = new Map<string, CustomerOfferStatus>();
    for (const r of rows) {
      const key = `${r.customerId}:${r.kind}`;
      if (!out.has(key)) out.set(key, r.status as CustomerOfferStatus);
    }
    return out;
  }

  /**
   * Las propuestas vivas del inquilino. Antes, las que ya contrató pasan a
   * aceptadas y las caducadas a expiradas; las no vistas se marcan vistas.
   */
  async listForPortal(tenantId: string, customerId: string): Promise<PortalOfferDto[]> {
    await this.expireDue(tenantId, customerId);
    let rows = await this.admin.customerOffer.findMany({
      where: { tenantId, customerId, status: { in: LIVE } },
      orderBy: { createdAt: 'desc' },
    });
    const accepted: string[] = [];
    for (const r of rows) {
      if (await this.fulfilled(tenantId, customerId, r.kind as OpportunityKind, r.createdAt)) {
        accepted.push(r.id);
      }
    }
    if (accepted.length) {
      await this.admin.customerOffer.updateMany({
        where: { id: { in: accepted } },
        data: { status: 'accepted', acceptedAt: new Date() },
      });
      rows = rows.filter((r) => !accepted.includes(r.id));
    }
    const unseen = rows.filter((r) => !r.seenAt).map((r) => r.id);
    if (unseen.length) {
      await this.admin.customerOffer.updateMany({
        where: { id: { in: unseen } },
        data: { seenAt: new Date() },
      });
    }
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as OpportunityKind,
      title: r.title,
      message: r.message,
      priceGross: r.priceGross != null ? Number(r.priceGross) : null,
      status: r.status as CustomerOfferStatus,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  }

  /** «Me interesa» avisa al equipo; «No, gracias» la retira del portal. */
  async respond(
    tenantId: string,
    customerId: string,
    offerId: string,
    input: PortalRespondOfferInput,
  ): Promise<PortalOfferDto[]> {
    const offer = await this.admin.customerOffer.findFirst({
      where: { id: offerId, tenantId, customerId, status: { in: LIVE } },
      include: {
        customer: {
          select: { firstName: true, lastName: true, companyName: true, customerType: true },
        },
      },
    });
    if (!offer) {
      throw new NotFoundException({ code: 'offer_not_found', message: 'Propuesta no encontrada' });
    }
    await this.admin.customerOffer.update({
      where: { id: offer.id },
      data: { status: input.response, respondedAt: new Date() },
    });
    if (input.response === 'interested') {
      const c = offer.customer;
      const name =
        c.customerType === 'business'
          ? (c.companyName ?? 'Un inquilino')
          : [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Un inquilino';
      await this.notifications
        .create(tenantId, {
          type: 'customer.offer_interested',
          title: `${name} quiere: ${offer.title.toLowerCase()}`,
          body: 'Respondió «Me interesa» a tu propuesta en su área de clientes.',
          link: `/customers/${customerId}`,
        })
        .catch(() => undefined);
    }
    return this.listForPortal(tenantId, customerId);
  }

  private async expireDue(tenantId: string, customerId?: string): Promise<void> {
    await this.admin.customerOffer.updateMany({
      where: {
        tenantId,
        ...(customerId ? { customerId } : {}),
        status: { in: LIVE },
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });
  }

  /** ¿Ha contratado ya lo propuesto después de la propuesta? */
  private async fulfilled(
    tenantId: string,
    customerId: string,
    kind: OpportunityKind,
    since: Date,
  ): Promise<boolean> {
    switch (kind) {
      case 'insurance':
        return (
          (await this.admin.contract.count({
            where: {
              tenantId,
              customerId,
              deletedAt: null,
              status: { in: ['active', 'ending'] },
              insurancePlanId: { not: null },
              updatedAt: { gt: since },
            },
          })) > 0
        );
      case 'additional_unit':
      case 'larger_unit':
        return (
          (await this.admin.contract.count({
            where: {
              tenantId,
              customerId,
              deletedAt: null,
              status: { in: ['draft', 'active', 'ending'] },
              createdAt: { gt: since },
            },
          })) > 0
        );
      case 'night_pass':
        return (
          (await this.admin.accessCredential.count({
            where: {
              tenantId,
              customerId,
              createdAt: { gt: since },
              metadata: { path: ['source'], equals: 'night_pass' },
            },
          })) > 0
        );
      case 'autopay': {
        const [methods, mandates] = await Promise.all([
          this.admin.paymentMethod.count({
            where: {
              tenantId,
              customerId,
              deletedAt: null,
              type: { in: ['card', 'sepa_debit'] },
              createdAt: { gt: since },
            },
          }),
          this.admin.sepaMandate.count({
            where: { tenantId, customerId, status: 'active', createdAt: { gt: since } },
          }),
        ]);
        return methods + mandates > 0;
      }
    }
  }
}
