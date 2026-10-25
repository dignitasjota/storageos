import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { resolveStaffEmailSettings, resolveUserEmailNotices } from '@storageos/shared';
import { Queue } from 'bullmq';

import { formatEur, todayInTimezone } from '../../common/format';
import { escapeHtml } from '../customer-emails/customer-emails.templates';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { TodayService } from './today.service';

import type { Env } from '../../config/env.schema';
import type { TodayDto } from '@storageos/shared';

/** Hora local del negocio a la que sale el resumen. */
const SEND_HOUR = 8;

function localHour(timeZone: string, now: Date): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    return Number(h);
  } catch {
    return now.getUTCHours();
  }
}

/** Líneas del resumen; vacío si no hay nada que contar. */
export function dailySummaryLines(t: TodayDto): string[] {
  const lines: string[] = [];
  const names = (items: { label: string; detail: string | null }[]) =>
    items
      .slice(0, 4)
      .map((i) => (i.detail ? `${i.label} (${i.detail})` : i.label))
      .join(', ');
  const more = (count: number, shown: number) => (count > shown ? ` y ${count - shown} más` : '');
  if (t.moveInsToday.count > 0) {
    lines.push(
      `Entradas: ${t.moveInsToday.count} — ${names(t.moveInsToday.items)}${more(t.moveInsToday.count, Math.min(4, t.moveInsToday.items.length))}`,
    );
  }
  if (t.moveOutsToday.count > 0) {
    lines.push(
      `Salidas: ${t.moveOutsToday.count} — ${names(t.moveOutsToday.items)}${more(t.moveOutsToday.count, Math.min(4, t.moveOutsToday.items.length))}`,
    );
  }
  if (t.invoicesDueToday.count > 0) {
    lines.push(
      `Facturas que vencen hoy: ${t.invoicesDueToday.count} (${formatEur(t.invoicesDueToday.totalDue)})`,
    );
  }
  if (t.invoicesOverdue.count > 0) {
    lines.push(
      `Facturas vencidas: ${t.invoicesOverdue.count} (${formatEur(t.invoicesOverdue.totalPending)} pendientes)`,
    );
  }
  if (t.signaturesPending.count > 0) {
    lines.push(`Contratos esperando firma: ${t.signaturesPending.count}`);
  }
  if (t.tasksDue.count > 0) lines.push(`Tareas para hoy o atrasadas: ${t.tasksDue.count}`);
  const followups = t.followupsDue.count + (t.leadFollowupsDue?.count ?? 0);
  if (followups > 0) lines.push(`Seguimientos para hoy: ${followups}`);
  if ((t.unattendedLeads?.count ?? 0) > 0) {
    lines.push(`Contactos sin atender: ${t.unattendedLeads.count}`);
  }
  if (t.unreadMessages > 0) lines.push(`Mensajes de inquilinos sin leer: ${t.unreadMessages}`);
  if (t.incidentsOpen > 0) lines.push(`Incidencias abiertas: ${t.incidentsOpen}`);
  return lines;
}

/**
 * Resumen del día por correo (a las 8:00 en la hora del negocio) a cada
 * usuario que lo active en su perfil: lo que toca hoy, con su alcance por
 * local. Corre en el API sin gatear: cada hora mira qué negocios están en su
 * hora y reserva el día con un `updateMany` condicionado (sin duplicados entre
 * réplicas). Solo se envía si hay algo.
 */
@Injectable()
export class DailySummaryService {
  private readonly logger = new Logger(DailySummaryService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly today: TodayService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  @Cron('5 * * * *', { name: 'today.daily-summary' })
  async cron(): Promise<void> {
    try {
      await this.sendDue();
    } catch (err) {
      this.logger.warn(`[daily-summary] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Negocios en su hora de envío que aún no lo han recibido hoy. */
  async sendDue(now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['active', 'trial'] } },
      select: { id: true, timezone: true },
    });
    let sent = 0;
    for (const t of tenants) {
      if (localHour(t.timezone, now) !== SEND_HOUR) continue;
      const day = todayInTimezone(t.timezone, now);
      const claimed = await this.admin.tenant.updateMany({
        where: {
          id: t.id,
          OR: [{ dailySummaryLastDate: null }, { dailySummaryLastDate: { lt: day } }],
        },
        data: { dailySummaryLastDate: day },
      });
      if (claimed.count === 0) continue;
      sent += await this.sendForTenant(t.id);
    }
    return sent;
  }

  /**
   * Envía el resumen a los usuarios del negocio que lo tienen activado (o solo
   * a `onlyUserId`, para la prueba desde el perfil, aunque no lo tenga).
   * Devuelve cuántos correos se encolaron.
   */
  async sendForTenant(tenantId: string, onlyUserId?: string): Promise<number> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, staffEmailSettings: true },
    });
    if (!tenant) return 0;
    if (!onlyUserId && !resolveStaffEmailSettings(tenant.staffEmailSettings).daily_summary) {
      return 0;
    }
    const users = await this.admin.user.findMany({
      where: {
        tenantId,
        isActive: true,
        emailVerifiedAt: { not: null },
        ...(onlyUserId ? { id: onlyUserId } : {}),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        emailNoticePrefs: true,
        facilities: { select: { facilityId: true } },
      },
    });
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    let queued = 0;
    for (const u of users) {
      if (!onlyUserId && !resolveUserEmailNotices(u.emailNoticePrefs, u.role).daily_summary) {
        continue;
      }
      try {
        const scope = u.facilities.length > 0 ? u.facilities.map((f) => f.facilityId) : null;
        const data = await this.today.getToday(tenantId, undefined, scope, u.id);
        const lines = dailySummaryLines(data);
        if (lines.length === 0 && !onlyUserId) continue;
        const body = lines.length > 0 ? lines : ['Hoy no hay nada pendiente.'];
        const subject =
          data.urgentCount > 0
            ? `Hoy en ${tenant.name}: ${data.urgentCount} ${data.urgentCount === 1 ? 'cosa urgente' : 'cosas urgentes'}`
            : `Hoy en ${tenant.name}`;
        const url = `${base}/today`;
        const text = [
          `Buenos días, ${u.fullName}.`,
          ...body,
          `Ver «Hoy»: ${url}`,
          'Puedes dejar de recibirlo en Ajustes → Perfil → Avisos.',
        ].join('\n\n');
        const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;max-width:560px">
<p style="font-size:13px;color:#64748b">${escapeHtml(tenant.name)}</p>
<h2 style="font-size:18px">Buenos días, ${escapeHtml(u.fullName)}</h2>
<ul style="font-size:15px;line-height:22px;padding-left:18px">${body.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Abrir «Hoy»</a></p>
<p style="font-size:12px;color:#94a3b8">Puedes dejar de recibirlo en Ajustes → Perfil → Avisos.</p>
</div>`;
        await this.emailQueue.add(JOB_EMAIL_SEND, {
          to: u.email.toLowerCase(),
          kind: 'staff_notice',
          subject,
          html,
          text,
        });
        queued += 1;
      } catch (err) {
        this.logger.warn(
          `[daily-summary] usuario ${u.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return queued;
  }
}
