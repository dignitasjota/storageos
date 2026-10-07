import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { Env } from '../../config/env.schema';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Avisos antes de caducar (días). 0 = ya ha caducado. */
const MILESTONES = [30, 15, 7, 0] as const;
/** Los ya caducados se siguen mostrando en el panel durante este plazo. */
const SHOW_EXPIRED_DAYS = 30;

/** Hito que corresponde a los días que quedan (null = aún no toca avisar). */
export function certExpiryMilestone(daysLeft: number): number | null {
  if (daysLeft <= 0) return 0;
  for (const m of [...MILESTONES].reverse()) {
    if (m > 0 && daysLeft <= m) return m;
  }
  return null;
}

export interface ExpiringCertificate {
  tenantId: string;
  tenantName: string;
  validTo: Date;
  daysLeft: number;
}

/**
 * Caducidad de los certificados de la AEAT de los tenants: sin certificado
 * vigente no se pueden enviar las facturas a Veri*Factu. Avisa al tenant
 * (notificación + email a los propietarios) a 30, 15 y 7 días y al caducar,
 * una vez por hito (`expiry_notified_days`).
 */
@Injectable()
export class AeatCertExpiryService {
  private readonly logger = new Logger(AeatCertExpiryService.name);
  private readonly settingsUrl: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.settingsUrl = `${config.get('WEB_BASE_URL', { infer: true })}/settings/billing/verifactu`;
  }

  /** Certificados vigentes que caducan en ≤30 días o caducados hace ≤30 días. */
  async expiring(now = new Date()): Promise<ExpiringCertificate[]> {
    const rows = await this.admin.tenantAeatCredential.findMany({
      where: {
        revokedAt: null,
        certValidTo: {
          lte: new Date(now.getTime() + 30 * DAY_MS),
          gte: new Date(now.getTime() - SHOW_EXPIRED_DAYS * DAY_MS),
        },
        tenant: { deletedAt: null },
      },
      orderBy: { certValidTo: 'asc' },
      select: { tenantId: true, certValidTo: true, tenant: { select: { name: true } } },
    });
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      validTo: r.certValidTo,
      daysLeft: Math.ceil((r.certValidTo.getTime() - now.getTime()) / DAY_MS),
    }));
  }

  /** Envía los avisos pendientes. Devuelve cuántos tenants se han avisado. */
  async run(now = new Date()): Promise<number> {
    const rows = await this.admin.tenantAeatCredential.findMany({
      where: {
        revokedAt: null,
        certValidTo: {
          lte: new Date(now.getTime() + 30 * DAY_MS),
          gte: new Date(now.getTime() - SHOW_EXPIRED_DAYS * DAY_MS),
        },
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        tenantId: true,
        certValidTo: true,
        expiryNotifiedDays: true,
        tenant: { select: { name: true } },
      },
    });
    let sent = 0;
    for (const r of rows) {
      const daysLeft = Math.ceil((r.certValidTo.getTime() - now.getTime()) / DAY_MS);
      const milestone = certExpiryMilestone(daysLeft);
      if (milestone === null) continue;
      if (r.expiryNotifiedDays !== null && r.expiryNotifiedDays <= milestone) continue;
      // Reserva del hito antes de avisar (sin duplicados entre réplicas).
      const claimed = await this.admin.tenantAeatCredential.updateMany({
        where: {
          id: r.id,
          OR: [{ expiryNotifiedDays: null }, { expiryNotifiedDays: { gt: milestone } }],
        },
        data: { expiryNotifiedDays: milestone },
      });
      if (claimed.count === 0) continue;
      try {
        await this.notify(r.tenantId, r.tenant.name, r.certValidTo, daysLeft);
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `[aeat-cert] aviso fallido tenant=${r.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }

  private async notify(
    tenantId: string,
    tenantName: string,
    validTo: Date,
    daysLeft: number,
  ): Promise<void> {
    const date = validTo.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
    const title =
      daysLeft <= 0
        ? 'Tu certificado de la AEAT ha caducado'
        : `Tu certificado de la AEAT caduca en ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}`;
    const body =
      daysLeft <= 0
        ? `Caducó el ${date}. Sin un certificado vigente no se pueden enviar las facturas a Veri*Factu: sube uno nuevo cuanto antes.`
        : `Caduca el ${date}. Renuévalo y súbelo antes para que el envío de facturas a Veri*Factu no se interrumpa.`;
    await this.notifications.create(tenantId, {
      type: 'aeat.certificate_expiring',
      title,
      body,
      link: '/settings/billing/verifactu',
    });

    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    if (owners.length === 0) return;
    const text = [
      `Hola, equipo de ${tenantName}:`,
      '',
      body,
      '',
      `Puedes subir el certificado nuevo en: ${this.settingsUrl}`,
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">${escapeHtml(
      text,
    ).replace(/\n/g, '<br>')}</div>`;
    await this.emailQueue.addBulk(
      owners.map((o) => ({
        name: JOB_EMAIL_SEND,
        data: { to: o.email, kind: 'staff_notice', subject: title, html, text },
      })),
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
