import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { LEAD_NURTURE_SOURCES, rentTax } from '@storageos/shared';

import { formatEur } from '../../common/format';
import { leadReplyAddress } from '../../common/lead-reply-address';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { DomainEventPayload } from '../automations/domain-events';

const DAY = 86_400_000;
/** Días desde el paso anterior para el 2.º y el 3.º correo (2 y 7 desde que llegó). */
const NEXT_STEP_DAYS: Record<number, number> = { 1: 2, 2: 5 };
const MAX_STEP = 3;

type Tenant = {
  id: string;
  name: string;
  slug: string;
  customDomain: string | null;
  customDomainVerifiedAt: Date | null;
};

/**
 * Secuencia automática para los contactos que llegan por la web (opcional,
 * por negocio): al llegar, los tamaños y precios con el enlace para reservar;
 * a los 2 días, «¿te ayudamos?», y a los 7, el último. Se corta en cuanto una
 * persona del equipo lo atiende, reserva, se pierde o se da de baja. El 2.º y
 * el 3.º son comerciales: solo con su consentimiento (el envío lo comprueba).
 */
@Injectable()
export class LeadNurtureService {
  private readonly logger = new Logger(LeadNurtureService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.lead_created, { async: true })
  async onLeadCreated(p: DomainEventPayload): Promise<void> {
    if (!p.leadId) return;
    try {
      await this.sendStep(p.tenantId, p.leadId, 1);
    } catch (err) {
      this.logger.warn(`Primer correo al contacto ${p.leadId} falló: ${(err as Error).message}`);
    }
  }

  /** Los pasos 2 y 3 que tocan (cron horario). */
  async runDue(now: Date = new Date()): Promise<number> {
    let sent = 0;
    for (const [fromStep, days] of Object.entries(NEXT_STEP_DAYS)) {
      const step = Number(fromStep);
      const due = await this.admin.lead.findMany({
        where: {
          nurtureStep: step,
          nurtureLastAt: { lte: new Date(now.getTime() - days * DAY) },
          deletedAt: null,
          status: { in: ['new', 'contacted'] },
          bookedAt: null,
          tenant: {
            leadNurtureEnabled: true,
            deletedAt: null,
            status: { in: ['active', 'trial'] },
          },
        },
        select: { id: true, tenantId: true },
        take: 200,
      });
      for (const l of due) {
        if (await this.sendStep(l.tenantId, l.id, step + 1, now)) sent += 1;
      }
    }
    return sent;
  }

  /** Reserva el paso (`updateMany` condicionado) y lo envía. */
  private async sendStep(
    tenantId: string,
    leadId: string,
    step: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (step < 1 || step > MAX_STEP) return false;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        leadNurtureEnabled: true,
      },
    });
    if (!tenant?.leadNurtureEnabled) return false;
    const lead = await this.admin.lead.findFirst({
      where: { id: leadId, tenantId, deletedAt: null },
      select: {
        id: true,
        source: true,
        email: true,
        firstName: true,
        companyName: true,
        marketingOptOutAt: true,
        preferredFacilityId: true,
        status: true,
        bookedAt: true,
      },
    });
    if (
      !lead?.email ||
      lead.marketingOptOutAt ||
      lead.bookedAt ||
      !['new', 'contacted'].includes(lead.status) ||
      !(LEAD_NURTURE_SOURCES as readonly string[]).includes(lead.source)
    ) {
      return false;
    }
    const { count } = await this.admin.lead.updateMany({
      where: { id: leadId, nurtureStep: step - 1 },
      data: { nurtureStep: step, nurtureLastAt: now },
    });
    if (count === 0) return false;

    const name = lead.firstName ?? lead.companyName ?? '';
    const hello = `Hola${name ? ` ${name}` : ''}:`;
    const bookUrl = this.bookUrl(tenant);
    const replyTo = await leadReplyAddress(
      this.admin,
      this.config.get<string>('INBOUND_EMAIL_DOMAIN'),
      leadId,
    );
    let subject: string;
    let body: string;
    if (step === 1) {
      const prices = await this.priceLines(tenantId, lead.preferredFacilityId);
      subject = `Gracias por escribirnos — ${tenant.name}`;
      body = [
        hello,
        '',
        'Gracias por tu interés. Te respondemos en cuanto podamos; mientras tanto, estos son nuestros tamaños y precios:',
        '',
        ...(prices.length ? prices : ['Consulta los tamaños disponibles en nuestra web.']),
        '',
        `Puedes reservar online en un par de minutos: ${bookUrl}`,
        '',
        'Si tienes cualquier duda, responde a este correo.',
        '',
        tenant.name,
      ].join('\n');
    } else if (step === 2) {
      subject = `¿Te ayudamos a elegir tu trastero?`;
      body = [
        hello,
        '',
        '¿Ya sabes qué tamaño necesitas? Si nos cuentas qué vas a guardar, te decimos cuál te encaja y te preparamos un presupuesto.',
        '',
        `También puedes reservar directamente aquí: ${bookUrl}`,
        '',
        tenant.name,
      ].join('\n');
    } else {
      subject = `Seguimos aquí si nos necesitas`;
      body = [
        hello,
        '',
        'No queremos molestarte: este es el último correo que te mandamos. Si más adelante necesitas un trastero, responde a este correo o reserva online cuando quieras:',
        bookUrl,
        '',
        tenant.name,
      ].join('\n');
    }
    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: lead.email,
      subject,
      bodyText: body,
      leadId,
      source: `lead.nurture_${step}`,
      ...(step > 1 ? { marketing: true } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    return true;
  }

  /** «Mediano (6 m²): desde 59,00 €/mes (IVA incl.)» por cada tamaño con sitio libre. */
  private async priceLines(tenantId: string, facilityId: string | null): Promise<string[]> {
    const units = await this.admin.unit.findMany({
      where: {
        tenantId,
        status: 'available',
        facility: { deletedAt: null, isActive: true },
        ...(facilityId ? { facilityId } : {}),
      },
      select: {
        basePriceMonthly: true,
        areaM2: true,
        unitType: { select: { id: true, name: true, propertyKind: true } },
      },
      orderBy: { basePriceMonthly: 'asc' },
      take: 2000,
    });
    const byType = new Map<string, { name: string; price: number; area: number | null }>();
    for (const u of units) {
      if (byType.has(u.unitType.id)) continue;
      const rate = rentTax(u.unitType.propertyKind).taxRate;
      byType.set(u.unitType.id, {
        name: u.unitType.name,
        price: Math.round(Number(u.basePriceMonthly) * (1 + rate / 100) * 100) / 100,
        area: u.areaM2 ? Number(u.areaM2) : null,
      });
    }
    return [...byType.values()]
      .sort((a, b) => a.price - b.price)
      .slice(0, 8)
      .map(
        (t) =>
          `· ${t.name}${t.area ? ` (${t.area} m²)` : ''}: desde ${formatEur(t.price)}/mes (IVA incl.)`,
      );
  }

  private bookUrl(tenant: Tenant): string {
    const qs = 'utm_source=correo&utm_medium=email&utm_campaign=bienvenida';
    if (tenant.customDomain && tenant.customDomainVerifiedAt) {
      return `https://${tenant.customDomain}/reservar?${qs}`;
    }
    const web = this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3000';
    return `${web}/book/${encodeURIComponent(tenant.slug)}?${qs}`;
  }
}
