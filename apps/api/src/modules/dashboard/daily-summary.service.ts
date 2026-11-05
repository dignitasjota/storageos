import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  parseDailySummaryPrefs,
  permissionsForRole,
  resolveStaffEmailSettings,
  resolveUserEmailNotices,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { formatEur, todayInTimezone } from '../../common/format';
import { escapeHtml } from '../customer-emails/customer-emails.templates';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PushService } from '../push/push.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { TodayExtrasService } from './today-extras.service';
import { TodayService } from './today.service';

import type { Env } from '../../config/env.schema';
import type { DailySummaryPrefs, Permission, TodayDto, TodayExtrasDto } from '@storageos/shared';

/**
 * Si el API estaba parado a la hora elegida (un despliegue), sale en la
 * siguiente pasada: el día se reserva, así que nunca sale dos veces.
 */
const SEND_WINDOW_HOURS = 3;

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
  if (t.collectionsDeadlines.count > 0) {
    lines.push(`Impagos con el plazo vencido: ${t.collectionsDeadlines.count}`);
  }
  const deposits = t.depositsToSettle.count + t.depositsToCollect.count;
  if (deposits > 0) lines.push(`Fianzas por cobrar o liquidar: ${deposits}`);
  if (t.depositsToRegister.count > 0) {
    lines.push(`Fianzas de vivienda sin depositar: ${t.depositsToRegister.count}`);
  }
  if (t.businessRemindersDue.count > 0) {
    lines.push(`Vencimientos del negocio: ${t.businessRemindersDue.count}`);
  }
  if (t.rgpdRequestsDue.count > 0) {
    lines.push(`Solicitudes de protección de datos: ${t.rgpdRequestsDue.count}`);
  }
  if (t.customerDocumentsExpiring.count > 0) {
    lines.push(`Documentos de inquilinos que caducan: ${t.customerDocumentsExpiring.count}`);
  }
  if (t.facilityDocumentsExpiring.count > 0) {
    lines.push(`Documentos de locales que caducan: ${t.facilityDocumentsExpiring.count}`);
  }
  return lines;
}

/** Lo de los apartados que completan «Hoy» y cuentan como asunto del día. */
export function dailySummaryExtraLines(e: TodayExtrasDto): string[] {
  const lines: string[] = [];
  if (e.chatsWaiting.count > 0)
    lines.push(`Chats esperando a una persona: ${e.chatsWaiting.count}`);
  if (e.paymentProblems.count > 0) {
    lines.push(`Cobros rechazados o devueltos hoy: ${e.paymentProblems.count}`);
  }
  if (e.draftsAttention.count > 0) {
    lines.push(`Contratos sin firmar que ya deberían estarlo: ${e.draftsAttention.count}`);
  }
  if (e.plansLate.count > 0) lines.push(`Planes de pago con cuota vencida: ${e.plansLate.count}`);
  return lines;
}

/**
 * Resumen del día a cada usuario que lo active en su perfil: por correo, por
 * push o por los dos, a la hora y de los locales que elija (por defecto a las
 * 8:00 del negocio y de todo lo que ve). Corre en el API sin gatear: cada hora
 * mira quién está en su hora y le reserva el día con un `updateMany`
 * condicionado (sin duplicados entre réplicas). Solo se envía si hay algo.
 */
@Injectable()
export class DailySummaryService {
  private readonly logger = new Logger(DailySummaryService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly today: TodayService,
    private readonly extras: TodayExtrasService,
    private readonly push: PushService,
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

  async getPrefs(tenantId: string, userId: string): Promise<DailySummaryPrefs> {
    const user = await this.admin.user.findFirst({
      where: { id: userId, tenantId },
      select: { dailySummaryPrefs: true },
    });
    return parseDailySummaryPrefs(user?.dailySummaryPrefs);
  }

  async setPrefs(
    tenantId: string,
    userId: string,
    prefs: DailySummaryPrefs,
  ): Promise<DailySummaryPrefs> {
    await this.admin.user.updateMany({
      where: { id: userId, tenantId },
      data: { dailySummaryPrefs: prefs },
    });
    return prefs;
  }

  /** Personas en su hora de envío que aún no lo han recibido hoy. */
  async sendDue(now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['active', 'trial'] } },
      select: { id: true, timezone: true },
    });
    let sent = 0;
    for (const t of tenants) {
      sent += await this.sendForTenant(t.id, undefined, {
        hour: localHour(t.timezone, now),
        day: todayInTimezone(t.timezone, now),
      });
    }
    return sent;
  }

  /** Si está en su hora, reserva el día de esa persona. */
  private async claimUser(
    userId: string,
    prefs: DailySummaryPrefs,
    slot: { hour: number; day: Date },
  ): Promise<boolean> {
    if (slot.hour < prefs.hour || slot.hour > prefs.hour + SEND_WINDOW_HOURS) return false;
    const claimed = await this.admin.user.updateMany({
      where: {
        id: userId,
        OR: [{ dailySummaryLastDate: null }, { dailySummaryLastDate: { lt: slot.day } }],
      },
      data: { dailySummaryLastDate: slot.day },
    });
    return claimed.count > 0;
  }

  /**
   * Envía el resumen a los usuarios del negocio que lo tienen activado (o solo
   * a `onlyUserId`, para la prueba desde el perfil, aunque no lo tenga).
   * Devuelve cuántos correos se encolaron.
   */
  async sendForTenant(
    tenantId: string,
    onlyUserId?: string,
    slot?: { hour: number; day: Date },
  ): Promise<number> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, staffEmailSettings: true },
    });
    if (!tenant) return 0;
    const companyEmail =
      !!onlyUserId || resolveStaffEmailSettings(tenant.staffEmailSettings).daily_summary;
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
        tenantRole: { select: { permissions: true } },
        emailNoticePrefs: true,
        dailySummaryPrefs: true,
        facilities: { select: { facilityId: true } },
      },
    });
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    let queued = 0;
    for (const u of users) {
      const prefs = parseDailySummaryPrefs(u.dailySummaryPrefs);
      const wantsEmail =
        !!onlyUserId ||
        (companyEmail && resolveUserEmailNotices(u.emailNoticePrefs, u.role).daily_summary);
      if (!wantsEmail && !prefs.push) continue;
      try {
        if (slot && !(await this.claimUser(u.id, prefs, slot))) continue;
        const allowed = u.facilities.map((f) => f.facilityId);
        // Los locales elegidos, sin salirse de los que la persona puede ver.
        const chosen = prefs.facilityIds.filter(
          (id) => allowed.length === 0 || allowed.includes(id),
        );
        const scope = chosen.length > 0 ? chosen : allowed.length > 0 ? allowed : null;
        // Como en el panel: un rol a medida (nunca el del propietario) manda.
        const permissions =
          u.role !== 'owner' && u.tenantRole
            ? (u.tenantRole.permissions as Permission[])
            : permissionsForRole(u.role);
        if (!permissions.includes('contracts:read')) continue;
        const data = await this.today.getToday(tenantId, {
          facilityScope: scope,
          userId: u.id,
          permissions,
        });
        const extra = await this.extras.extras(tenantId, {
          facilityScope: scope,
          userId: u.id,
          permissions,
        });
        const lines = [...dailySummaryLines(data), ...dailySummaryExtraLines(extra)];
        if (lines.length === 0 && !onlyUserId) continue;
        const urgent = data.urgentCount + extra.urgentCount;
        const body = lines.length > 0 ? lines : ['Hoy no hay nada pendiente.'];
        const subject =
          urgent > 0
            ? `Hoy en ${tenant.name}: ${urgent} ${urgent === 1 ? 'asunto' : 'asuntos'}`
            : `Hoy en ${tenant.name}`;
        if (prefs.push && !onlyUserId) {
          await this.push.sendToStaff(tenantId, {
            type: 'today.daily_summary',
            title: subject,
            body: body.slice(0, 3).join(' · '),
            link: '/today',
            userId: u.id,
          });
        }
        if (!wantsEmail) continue;
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
