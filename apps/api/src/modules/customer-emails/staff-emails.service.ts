import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  resolveStaffEmailSettings,
  type StaffEmailKind,
  type StaffEmailSettingsDto,
  type UpdateStaffEmailSettingsInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type BookingCreatedPayload,
  type DomainEventPayload,
} from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { escapeHtml } from './customer-emails.templates';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

/** Leads que llegan solos desde fuera (no los que da de alta el staff). */
const PUBLIC_LEAD_SOURCES = new Set(['web', 'widget']);

interface StaffMessage {
  subject: string;
  lines: string[];
  /** Ruta del panel (se prefija con WEB_BASE_URL). */
  path: string;
  cta: string;
  /**
   * Local del aviso: solo lo reciben quienes ven todos los locales y quienes
   * tienen ese local asignado. Null = de toda la empresa.
   */
  facilityId: string | null;
}

/**
 * Avisos por email al equipo del tenant (propietarios y gestores) de lo que
 * pasa sin que estén delante: contacto desde la web, reserva online, baja o
 * incidencia del inquilino. Hasta ahora solo había aviso dentro de la app; si
 * nadie entraba, no se enteraban. Activados por defecto; se apagan en
 * Ajustes → Correo. Salen con el remitente de la plataforma (es la plataforma
 * avisando al tenant) por la cola `email`.
 */
@Injectable()
export class StaffEmailsService {
  private readonly logger = new Logger(StaffEmailsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  async getSettings(tenantId: string): Promise<StaffEmailSettingsDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { staffEmailSettings: true },
    });
    return resolveStaffEmailSettings(t?.staffEmailSettings);
  }

  async updateSettings(
    tenantId: string,
    userId: string,
    input: UpdateStaffEmailSettingsInput,
  ): Promise<StaffEmailSettingsDto> {
    const next: StaffEmailSettingsDto = { ...(await this.getSettings(tenantId)) };
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'boolean') next[k as StaffEmailKind] = v;
    }
    const stored = Object.fromEntries(
      Object.entries(next)
        .filter(([, on]) => !on)
        .map(([k]) => [k, false]),
    );
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { staffEmailSettings: stored as Prisma.InputJsonValue },
    });
    await this.audit.write({
      tenantId,
      userId,
      action: 'tenant.staff_emails.settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: input,
    });
    return next;
  }

  @OnEvent(DOMAIN_EVENTS.lead_created, { async: true, promisify: true })
  async onLeadCreated(p: DomainEventPayload): Promise<void> {
    await this.safe('new_lead', p.tenantId, async () => {
      const lead = await this.admin.lead.findFirst({
        where: { id: p.entityId, tenantId: p.tenantId },
        select: {
          source: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          phone: true,
          message: true,
          preferredFacilityId: true,
        },
      });
      if (!lead || !PUBLIC_LEAD_SOURCES.has(lead.source)) return;
      const name =
        lead.companyName ?? ([lead.firstName, lead.lastName].filter(Boolean).join(' ') || '—');
      await this.notify(p.tenantId, 'new_lead', {
        subject: `Nuevo contacto desde tu web: ${name}`,
        lines: [
          `Nombre: ${name}`,
          lead.email ? `Email: ${lead.email}` : '',
          lead.phone ? `Teléfono: ${lead.phone}` : '',
          lead.message ? `Mensaje: ${lead.message}` : '',
        ],
        path: '/leads',
        cta: 'Ver contactos',
        facilityId: lead.preferredFacilityId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.booking_created, { async: true, promisify: true })
  async onBookingCreated(p: BookingCreatedPayload): Promise<void> {
    await this.safe('new_booking', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.contractId);
      if (!c) return;
      await this.notify(p.tenantId, 'new_booking', {
        subject: `Reserva online: trastero ${c.unit.code} (${c.unit.facility.name})`,
        lines: [
          `Cliente: ${customerName(c.customer)}`,
          c.customer.email ? `Email: ${c.customer.email}` : '',
          c.customer.phone ? `Teléfono: ${c.customer.phone}` : '',
          `Inicio: ${day(c.startDate)} · Cuota: ${eur(Number(c.priceMonthly))}/mes`,
          'Queda pendiente de que firme y pague; si no lo hace en 72 h, el trastero se libera solo.',
        ],
        path: `/contracts/${c.id}`,
        cta: 'Ver el contrato',
        facilityId: c.unit.facilityId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_move_out_requested, { async: true, promisify: true })
  async onMoveOutRequested(p: DomainEventPayload): Promise<void> {
    await this.safe('move_out_requested', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.entityId);
      if (!c) return;
      await this.notify(p.tenantId, 'move_out_requested', {
        subject: `Baja solicitada: trastero ${c.unit.code} (${c.unit.facility.name})`,
        lines: [
          `Inquilino: ${customerName(c.customer)}`,
          `Contrato: ${c.contractNumber}`,
          c.endDate ? `Fecha de baja: ${day(c.endDate)}` : '',
        ],
        path: `/contracts/${c.id}`,
        cta: 'Ver el contrato',
        facilityId: c.unit.facilityId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.incident_created, { async: true, promisify: true })
  async onIncidentCreated(p: DomainEventPayload): Promise<void> {
    await this.safe('portal_incident', p.tenantId, async () => {
      const inc = await this.admin.incident.findFirst({
        where: { id: p.entityId, tenantId: p.tenantId },
        select: {
          title: true,
          description: true,
          reportedByUserId: true,
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
              email: true,
              phone: true,
            },
          },
          facilityId: true,
          facility: { select: { name: true } },
        },
      });
      // Solo las que reporta el inquilino desde su área de clientes.
      if (!inc || inc.reportedByUserId || !inc.customer) return;
      await this.notify(p.tenantId, 'portal_incident', {
        subject: `Incidencia de un inquilino: ${inc.title}`,
        lines: [
          `Inquilino: ${customerName(inc.customer)}`,
          inc.facility ? `Local: ${inc.facility.name}` : '',
          inc.description ? `Detalle: ${inc.description}` : '',
        ],
        path: '/incidents',
        cta: 'Ver incidencias',
        facilityId: inc.facilityId,
      });
    });
  }

  // -------------------------------------------------------------------------

  private async notify(tenantId: string, kind: StaffEmailKind, msg: StaffMessage): Promise<void> {
    const settings = await this.getSettings(tenantId);
    if (!settings[kind]) return;
    const [tenant, staff] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.admin.user.findMany({
        where: {
          tenantId,
          role: { in: ['owner', 'manager'] },
          isActive: true,
          emailVerifiedAt: { not: null },
          // Un usuario restringido a ciertos locales solo recibe los suyos.
          ...(msg.facilityId
            ? {
                OR: [
                  { facilities: { none: {} } },
                  { facilities: { some: { facilityId: msg.facilityId } } },
                ],
              }
            : {}),
        },
        select: { email: true },
      }),
    ]);
    const to = [...new Set(staff.map((u) => u.email.toLowerCase()))];
    if (!tenant || to.length === 0) return;

    const url = `${this.config.get('WEB_BASE_URL', { infer: true })}${msg.path}`;
    const lines = msg.lines.filter(Boolean);
    const text = [...lines, `${msg.cta}: ${url}`, `— Avisos de ${tenant.name} en TrasterOS`].join(
      '\n\n',
    );
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;max-width:560px">
<p style="font-size:13px;color:#64748b">${escapeHtml(tenant.name)}</p>
<h2 style="font-size:18px">${escapeHtml(msg.subject)}</h2>
${lines.map((l) => `<p style="font-size:15px;line-height:22px;margin:6px 0">${escapeHtml(l)}</p>`).join('\n')}
<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(msg.cta)}</a></p>
<p style="font-size:12px;color:#94a3b8">Puedes desactivar estos avisos en Ajustes → Correo.</p>
</div>`;
    await this.emailQueue.addBulk(
      to.map((address) => ({
        name: JOB_EMAIL_SEND,
        data: { to: address, kind: 'staff_notice', subject: msg.subject, html, text },
      })),
    );
  }

  private contract(tenantId: string, contractId: string) {
    return this.admin.contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      select: {
        id: true,
        contractNumber: true,
        priceMonthly: true,
        startDate: true,
        endDate: true,
        unit: { select: { code: true, facilityId: true, facility: { select: { name: true } } } },
        customer: {
          select: {
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            email: true,
            phone: true,
          },
        },
      },
    });
  }

  private async safe(kind: StaffEmailKind, tenantId: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `[staff-email ${kind}] tenant=${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Cliente';
}

const eur = (n: number): string =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

const day = (d: Date): string =>
  new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
  }).format(d);
