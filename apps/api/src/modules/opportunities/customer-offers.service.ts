import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OPPORTUNITY_LABELS,
  type CustomerOfferStatus,
  type OpportunityKind,
  type PortalOfferDto,
  type PortalRespondOfferInput,
} from '@storageos/shared';

import { customerVisibilityFacilities } from '../../common/customer-scope';
import { todayInTimezone } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Prisma } from '@storageos/database';

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

  /**
   * Crea la propuesta salvo que se haya hecho la misma hace menos de `guardMs`
   * (devuelve null). El inquilino y el tipo se bloquean mientras se comprueba:
   * dos peticiones a la vez no crean dos propuestas.
   */
  async createOnce(args: {
    tenantId: string;
    customerId: string;
    kind: OpportunityKind;
    message: string;
    priceGross: number | null;
    userId: string | null;
    metadata: Record<string, unknown>;
    guardMs: number;
  }): Promise<string | null> {
    return this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offer:${args.tenantId}:${args.customerId}:${args.kind}`}))`;
      const recent = await tx.customerOffer.findFirst({
        where: {
          tenantId: args.tenantId,
          customerId: args.customerId,
          kind: args.kind,
          createdAt: { gte: new Date(Date.now() - args.guardMs) },
        },
        select: { id: true },
      });
      if (recent) return null;
      return this.create(args, tx);
    });
  }

  /** Crea la propuesta (sustituye a la anterior del mismo tipo aún viva). */
  async create(
    args: {
      tenantId: string;
      customerId: string;
      kind: OpportunityKind;
      message: string;
      priceGross: number | null;
      userId: string | null;
      metadata?: Record<string, unknown>;
    },
    db: Prisma.TransactionClient | PrismaAdminService = this.admin,
  ): Promise<string> {
    await db.customerOffer.updateMany({
      where: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        kind: args.kind,
        status: { in: LIVE },
      },
      data: { status: 'expired' },
    });
    const row = await db.customerOffer.create({
      data: {
        tenantId: args.tenantId,
        customerId: args.customerId,
        kind: args.kind,
        title: OPPORTUNITY_LABELS[args.kind],
        message: args.message,
        priceGross: args.priceGross,
        expiresAt: new Date(Date.now() + OFFER_DAYS * DAY),
        createdByUserId: args.userId,
        metadata: (args.metadata ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Última propuesta por `<customerId>:<kind>` (para Oportunidades): su estado
   * y cuándo se hizo (también las registradas por WhatsApp).
   */
  async lastStatusByCustomerKind(
    tenantId: string,
    customerId?: string,
  ): Promise<Map<string, { status: CustomerOfferStatus; createdAt: Date }>> {
    await this.expireDue(tenantId, customerId);
    const rows = await this.admin.customerOffer.findMany({
      where: { tenantId, ...(customerId ? { customerId } : {}) },
      select: { customerId: true, kind: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const out = new Map<string, { status: CustomerOfferStatus; createdAt: Date }>();
    for (const r of rows) {
      const key = `${r.customerId}:${r.kind}`;
      if (!out.has(key)) {
        out.set(key, { status: r.status as CustomerOfferStatus, createdAt: r.createdAt });
      }
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
      if (
        await this.fulfilled(
          tenantId,
          customerId,
          r.kind as OpportunityKind,
          r.createdAt,
          (r.metadata as Record<string, unknown> | null) ?? {},
        )
      ) {
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
      // No se pierde: un seguimiento para hoy a nombre de quien la propuso, y
      // el aviso a esa persona (o a quien ve al inquilino, si no hay autor).
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      await this.admin.customerFollowup
        .create({
          data: {
            tenantId,
            customerId,
            userId: offer.createdByUserId,
            title: `Contactar: le interesa ${offer.title.toLowerCase()}`,
            note: 'Respondió «Me interesa» en su área de clientes.',
            dueDate: todayInTimezone(tenant?.timezone ?? 'Europe/Madrid'),
          },
        })
        .catch(() => undefined);
      const notice = {
        type: 'customer.offer_interested',
        title: `${name} quiere: ${offer.title.toLowerCase()}`,
        body: 'Respondió «Me interesa» a tu propuesta en su área de clientes.',
        link: `/customers/${customerId}`,
      };
      if (offer.createdByUserId) {
        await this.notifications
          .create(tenantId, { ...notice, userId: offer.createdByUserId })
          .catch(() => undefined);
      } else {
        const facilities = await customerVisibilityFacilities(this.admin, tenantId, customerId);
        await this.notifications
          .createForFacilities(tenantId, facilities, notice)
          .catch(() => undefined);
      }
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
    meta: Record<string, unknown>,
  ): Promise<boolean> {
    switch (kind) {
      case 'insurance': {
        // Los contratos que no tenían seguro al proponerlo (antes bastaba con
        // tocar cualquier contrato que ya lo tuviera).
        const ids = Array.isArray(meta.contractIds) ? (meta.contractIds as string[]) : null;
        return (
          (await this.admin.contract.count({
            where: {
              tenantId,
              customerId,
              deletedAt: null,
              status: { in: ['active', 'ending'] },
              insurancePlanId: { not: null },
              ...(ids ? { id: { in: ids } } : { updatedAt: { gt: since } }),
            },
          })) > 0
        );
      }
      case 'larger_unit': {
        // Contrató otro trastero o se le cambió el suyo.
        const contractId = typeof meta.contractId === 'string' ? meta.contractId : null;
        const [newContracts, moved] = await Promise.all([
          this.admin.contract.count({
            where: {
              tenantId,
              customerId,
              deletedAt: null,
              status: { in: ['draft', 'active', 'ending'] },
              createdAt: { gt: since },
            },
          }),
          this.admin.contractEvent.count({
            where: {
              tenantId,
              eventType: 'unit_changed',
              occurredAt: { gt: since },
              contract: contractId ? { id: contractId } : { customerId },
            },
          }),
        ]);
        return newContracts + moved > 0;
      }
      case 'additional_unit':
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
