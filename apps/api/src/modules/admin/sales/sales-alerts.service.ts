import { Injectable, Logger } from '@nestjs/common';
import { platformLeadName, renderAdminEmail } from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { EmailService } from '../../email/email.service';
import { PlanLimitsService } from '../../plan-limits/plan-limits.service';
import { AdminQuoteService } from '../admin-quote.service';

import { DAY, daysUntil } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';

/** Días antes de que caduque una propuesta en que se le recuerda al cliente. */
const OFFER_REMINDER_DAYS = 3;
/** Uso del plan a partir del cual se avisa al comercial. */
const LIMIT_WARNING = 0.8;
const YEAR_MINUTES = 60 * 24 * 365;

/**
 * Avisos de venta al comercial (prueba que acaba, pago pendiente, cerca del
 * límite del plan, interés por una función, propuesta aceptada) y el
 * recordatorio al cliente de una propuesta que va a caducar.
 */
@Injectable()
export class SalesAlertsService {
  private readonly logger = new Logger(SalesAlertsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notify: SalesNotifyService,
    private readonly limits: PlanLimitsService,
    private readonly quotes: AdminQuoteService,
    private readonly email: EmailService,
  ) {}

  async run(now = new Date()): Promise<Record<string, number>> {
    const out = {
      trialEnding: 0,
      pastDue: 0,
      limitNear: 0,
      interest: 0,
      accepted: 0,
      reminders: 0,
    };
    const tenants = await this.admin.tenant.findMany({
      where: { salesRepId: { not: null }, deletedAt: null, salesRep: { isActive: true } },
      select: {
        id: true,
        name: true,
        status: true,
        trialEndsAt: true,
        salesRepId: true,
        subscription: { select: { status: true } },
        platformLead: { select: { id: true } },
      },
    });
    const ids = tenants.map((t) => t.id);
    const link = (t: (typeof tenants)[number]) =>
      t.platformLead ? `/admin/sales/accounts/${t.platformLead.id}` : '/admin/sales/clients';

    for (const t of tenants) {
      const repId = t.salesRepId!;
      const left = t.status === 'trial' ? daysUntil(t.trialEndsAt, now) : null;
      if (left !== null && left >= 0 && left <= 3) {
        if (
          await this.notify.repOnce(
            repId,
            `trial:${t.id}:${t.trialEndsAt?.toISOString().slice(0, 10)}`,
            YEAR_MINUTES,
            {
              type: 'sales.trial_ending',
              title: `A ${t.name} le quedan ${left} días de prueba`,
              body: 'Buen momento para proponerle el plan.',
              link: link(t),
            },
          )
        ) {
          out.trialEnding += 1;
        }
      }
      // Suspendida o de baja: ya no es «para que no pierda el acceso».
      if (t.subscription?.status === 'past_due' && t.status === 'active') {
        if (
          await this.notify.repOnce(repId, `past_due:${t.id}`, 60 * 24 * 7, {
            type: 'sales.past_due',
            title: `${t.name} tiene un pago pendiente`,
            body: 'Llámale para que no pierda el acceso.',
            link: link(t),
          })
        ) {
          out.pastDue += 1;
        }
      }
    }

    // Cerca del límite de trasteros de su plan.
    if (ids.length) {
      const units = await this.admin.unit.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids } },
        _count: { _all: true },
      });
      for (const u of units) {
        const t = tenants.find((x) => x.id === u.tenantId)!;
        const lim = await this.limits.resolveLimits(u.tenantId);
        if (!lim.units || u._count._all < lim.units * LIMIT_WARNING) continue;
        const month = now.toISOString().slice(0, 7);
        if (
          await this.notify.repOnce(t.salesRepId!, `limit:${t.id}:${month}`, YEAR_MINUTES, {
            type: 'sales.limit_near',
            title: `${t.name} usa ${u._count._all} de ${lim.units} trasteros de su plan`,
            body: 'Le puede interesar subir de plan o ampliar trasteros.',
            link: link(t),
          })
        ) {
          out.limitNear += 1;
        }
      }

      // Interés por funciones de pago (3 veces en 7 días).
      const interest = await this.admin.featureInterestEvent.groupBy({
        by: ['tenantId', 'feature'],
        where: { tenantId: { in: ids }, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } },
        _count: { _all: true },
      });
      for (const i of interest.filter((x) => x._count._all >= 3)) {
        const t = tenants.find((x) => x.id === i.tenantId)!;
        if (
          await this.notify.repOnce(t.salesRepId!, `interest:${t.id}:${i.feature}`, 60 * 24 * 30, {
            type: 'sales.feature_interest',
            title: `${t.name} intenta usar una función que no tiene`,
            body: `Ha entrado ${i._count._all} veces esta semana. Mira «Oportunidades».`,
            link: link(t),
          })
        ) {
          out.interest += 1;
        }
      }
    }

    // Propuestas aceptadas en las últimas 48 h.
    const accepted = await this.admin.platformQuoteOffer.findMany({
      where: {
        status: 'accepted',
        resolvedAt: { gte: new Date(now.getTime() - 2 * DAY) },
        superAdminId: { not: null },
      },
      include: {
        tenant: { select: { name: true } },
        lead: { select: { id: true, companyName: true, contactName: true, email: true } },
      },
    });
    for (const o of accepted) {
      const rep = await this.admin.superAdmin.findUnique({
        where: { id: o.superAdminId! },
        select: { role: true },
      });
      if (rep?.role !== 'sales') continue;
      const name = o.tenant?.name ?? (o.lead ? platformLeadName(o.lead) : 'Un cliente');
      if (
        await this.notify.repOnce(o.superAdminId!, `accepted:${o.id}`, YEAR_MINUTES, {
          type: 'sales.offer_accepted',
          title: `${name} ha aceptado tu propuesta`,
          body: null,
          link: o.lead ? `/admin/sales/accounts/${o.lead.id}` : '/admin/sales/offers',
        })
      ) {
        out.accepted += 1;
      }
    }

    out.reminders = await this.offerReminders(now);
    return out;
  }

  /** Recordatorio al cliente de una propuesta del comercial que va a caducar. */
  private async offerReminders(now: Date): Promise<number> {
    const soon = new Date(now.getTime() + OFFER_REMINDER_DAYS * DAY);
    const offers = await this.admin.platformQuoteOffer.findMany({
      where: {
        status: 'sent',
        reminderSentAt: null,
        expiresAt: { gt: now, lte: soon },
        superAdminId: { not: null },
        // Ni a un lead perdido o descartado ni a una cuenta de baja.
        AND: [
          { OR: [{ leadId: null }, { lead: { discardedAt: null, status: { not: 'lost' } } }] },
          {
            OR: [
              { tenantId: null },
              { tenant: { deletedAt: null, status: { in: ['trial', 'active'] } } },
            ],
          },
        ],
      },
      include: {
        tenant: {
          select: {
            name: true,
            salesRepId: true,
            users: {
              where: { role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
              select: { email: true },
            },
          },
        },
        lead: { select: { email: true, contactName: true, companyName: true, salesRepId: true } },
      },
      take: 200,
    });
    let sent = 0;
    for (const o of offers) {
      const rep = await this.admin.superAdmin.findUnique({
        where: { id: o.superAdminId! },
        select: { role: true, isActive: true, fullName: true, email: true, phone: true },
      });
      if (rep?.role !== 'sales' || !rep.isActive) continue;
      // Solo si la cuenta sigue siendo suya.
      const owner = o.tenant ? o.tenant.salesRepId : (o.lead?.salesRepId ?? null);
      if (owner !== o.superAdminId) continue;
      const claimed = await this.admin.platformQuoteOffer.updateMany({
        where: { id: o.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count === 0) continue;
      const to = [
        ...new Set([
          ...(o.tenant?.users.map((u) => u.email.toLowerCase()) ?? []),
          ...(o.lead?.email ? [o.lead.email.toLowerCase()] : []),
        ]),
      ];
      if (to.length === 0) continue;
      const hello = o.lead?.contactName?.trim().split(/\s+/)[0];
      const days = Math.max(1, Math.ceil((o.expiresAt!.getTime() - now.getTime()) / DAY));
      const body = [
        `Hola${hello ? ` ${hello}` : ''}:`,
        '',
        `Te recuerdo que la propuesta de TrasterOS que te envié vale ${days === 1 ? 'hasta mañana' : `${days} días más`}.`,
        '',
        `[[boton: Ver la propuesta | ${this.quotes.trackedUrl(o.id)}]]`,
        '',
        'Si tienes cualquier duda, respóndeme a este correo o llámame.',
        '',
        [rep.fullName, 'TrasterOS', rep.phone].filter(Boolean).join('  \n'),
      ].join('\n');
      const mail = renderAdminEmail(body);
      for (const email of to) {
        await this.email
          .sendRendered({
            to: email,
            subject: 'Tu propuesta de TrasterOS caduca pronto',
            html: mail.html,
            text: mail.text,
            fromName: `${rep.fullName} · TrasterOS`,
            replyTo: { email: rep.email, name: rep.fullName },
            kind: 'web_contact',
            tags: { type: 'sales' },
          })
          .catch((err: unknown) =>
            this.logger.warn(`[sales] recordatorio ${o.id}: ${String(err)}`),
          );
      }
      sent += 1;
    }
    return sent;
  }
}
