import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OPPORTUNITY_LABELS,
  OpportunityKindEnum,
  type CustomerOfferStatus,
  type OpportunityKind,
  type OpportunityResultsDto,
  type PortalOfferDto,
  type PortalRespondOfferInput,
} from '@storageos/shared';

import { customerScopeWhere, customerVisibilityFacilities } from '../../common/customer-scope';
import { type FacilityScope } from '../../common/facility-scope';
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
      url: safeUrl((r.metadata as Record<string, unknown> | null)?.url),
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
      case 'annual_prepay': {
        const ids = contractIdsOf(meta);
        return (
          (await this.admin.contract.count({
            where: {
              tenantId,
              customerId,
              deletedAt: null,
              billingIntervalMonths: { gt: 1 },
              ...(ids ? { id: { in: ids } } : { updatedAt: { gt: since } }),
            },
          })) > 0
        );
      }
      case 'renewal': {
        // Se prorrogó (fecha de fin posterior) o pasó a renovación automática.
        const contractId = typeof meta.contractId === 'string' ? meta.contractId : null;
        const endDate = typeof meta.endDate === 'string' ? new Date(meta.endDate) : null;
        if (!contractId) return false;
        const c = await this.admin.contract.findFirst({
          where: { id: contractId, tenantId },
          select: { endDate: true, autoRenew: true, status: true },
        });
        if (!c || c.status === 'ended' || c.status === 'cancelled') return false;
        return c.autoRenew || !c.endDate || (!!endDate && c.endDate > endDate);
      }
      case 'incomplete_data': {
        const c = await this.admin.customer.findFirst({
          where: { id: customerId, tenantId },
          select: { phone: true, documentNumber: true, address: true },
        });
        return !!(c?.phone && c.documentNumber && c.address);
      }
      case 'referral':
        return (
          (await this.admin.referral.count({
            where: { tenantId, referrerCustomerId: customerId, createdAt: { gt: since } },
          })) > 0
        );
      case 'smaller_unit': {
        // Se quedó: le cambiamos el trastero o anuló la baja.
        const contractId = typeof meta.contractId === 'string' ? meta.contractId : null;
        if (!contractId) return false;
        const [moved, stayed] = await Promise.all([
          this.admin.contractEvent.count({
            where: {
              tenantId,
              contractId,
              eventType: 'unit_changed',
              occurredAt: { gt: since },
            },
          }),
          this.admin.contract.count({ where: { id: contractId, tenantId, status: 'active' } }),
        ]);
        return moved + stayed > 0;
      }
      case 'google_review':
        // No hay forma de saber si la dejó: se queda abierta hasta caducar.
        return false;
    }
  }

  /** Revisa las propuestas abiertas por si ya lo contrató (las del área de clientes lo hacen al abrirse). */
  async refreshAccepted(tenantId: string): Promise<void> {
    await this.expireDue(tenantId);
    const rows = await this.admin.customerOffer.findMany({
      where: { tenantId, status: { in: LIVE } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, customerId: true, kind: true, createdAt: true, metadata: true },
    });
    const accepted: string[] = [];
    for (const r of rows) {
      if (
        await this.fulfilled(
          tenantId,
          r.customerId,
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
    }
  }

  /** Cuántas propuestas ha marcado el inquilino como «me interesa» y siguen abiertas. */
  async interestedCount(tenantId: string, scope: FacilityScope): Promise<number> {
    return this.admin.customerOffer.count({
      where: {
        tenantId,
        status: 'interested',
        expiresAt: { gt: new Date() },
        customer: { deletedAt: null, ...customerScopeWhere(scope ?? null) },
      },
    });
  }

  /** Qué ha pasado con las propuestas de los últimos días, por tipo. */
  async results(
    tenantId: string,
    days: number,
    scope: FacilityScope,
  ): Promise<OpportunityResultsDto> {
    await this.refreshAccepted(tenantId);
    const rows = await this.admin.customerOffer.findMany({
      where: {
        tenantId,
        createdAt: { gte: new Date(Date.now() - days * 86_400_000) },
        customer: { deletedAt: null, ...customerScopeWhere(scope ?? null) },
      },
      select: { kind: true, status: true, seenAt: true, priceGross: true },
      take: 20_000,
    });
    const empty = () => ({
      proposed: 0,
      seen: 0,
      interested: 0,
      accepted: 0,
      declined: 0,
      monthlyValue: 0,
    });
    const totals = empty();
    const byKind = Object.fromEntries(
      OpportunityKindEnum.options.map((k) => [k, empty()]),
    ) as OpportunityResultsDto['byKind'];
    for (const r of rows) {
      const k = byKind[r.kind as OpportunityKind];
      for (const row of k ? [totals, k] : [totals]) {
        row.proposed += 1;
        if (r.seenAt) row.seen += 1;
        if (r.status === 'interested') row.interested += 1;
        if (r.status === 'accepted') {
          row.accepted += 1;
          // Cuotas (no el pase nocturno, que es un pago suelto).
          if (r.priceGross != null && r.kind !== 'night_pass') {
            row.monthlyValue =
              Math.round((row.monthlyValue + Number(r.priceGross) / 1.21) * 100) / 100;
          }
        }
        if (r.status === 'declined') row.declined += 1;
      }
    }
    return { days, totals, byKind };
  }
}

function contractIdsOf(meta: Record<string, unknown>): string[] | null {
  if (Array.isArray(meta.contractIds)) return meta.contractIds as string[];
  if (typeof meta.contractId === 'string') return [meta.contractId];
  return null;
}

function safeUrl(v: unknown): string | null {
  return typeof v === 'string' && /^https:\/\//i.test(v) ? v : null;
}
