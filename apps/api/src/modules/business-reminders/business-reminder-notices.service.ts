import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { daysBetween, reminderNoticeKind, reminderWhenLabel } from '@storageos/shared';
import { Queue } from 'bullmq';

import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { isUniqueViolation } from '../../common/prisma-errors';
import { escapeHtml, tenantEmailShell } from '../../common/tenant-email-layout';
import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { Env } from '../../config/env.schema';

/** Hora local del negocio a partir de la que salen los avisos. */
const SEND_HOUR = 8;

function localParts(timeZone: string, now: Date): { hour: number; weekday: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? now.getUTCHours());
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    return { hour, weekday };
  } catch {
    return { hour: now.getUTCHours(), weekday: now.getUTCDay() };
  }
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Recipient {
  id: string;
  email: string;
  fullName: string;
}

type ReminderForNotice = {
  id: string;
  tenantId: string;
  facilityId: string | null;
  title: string;
  dueDate: Date;
  amount: { toString(): string } | null;
  vendor: string | null;
  link: string | null;
  notes: string | null;
  notifyDaysBefore: number[];
  notifyEmail: boolean;
  notifyInApp: boolean;
  notifyPush: boolean;
  recipientMode: string;
  recipientUserIds: string[];
  extraEmails: string[];
  overdueReminders: boolean;
  overdueMaxDays: number;
  snoozedUntil: Date | null;
  facility: { name: string } | null;
};

/**
 * Avisos de los vencimientos del negocio. Corre en el API sin gatear (como el
 * resumen del día): cada hora mira los negocios que ya han pasado las 8:00 en
 * su hora, calcula qué aviso toca a cada vencimiento y lo reserva en
 * `business_reminder_notices` (único) antes de enviarlo: sin duplicados entre
 * réplicas ni si el cron se salta una hora. Los lunes, el resumen semanal.
 */
@Injectable()
export class BusinessReminderNoticesService {
  private readonly logger = new Logger(BusinessReminderNoticesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  @Cron('10 * * * *', { name: 'business-reminders.notices' })
  async cron(): Promise<void> {
    try {
      await this.sendDue();
    } catch (err) {
      this.logger.warn(`[business-reminders] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Avisos y resúmenes pendientes. Devuelve cuántos avisos se enviaron. */
  async sendDue(
    now = new Date(),
    onlyTenantId?: string,
  ): Promise<{ notices: number; digests: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { in: ['active', 'trial'] },
        ...(onlyTenantId ? { id: onlyTenantId } : {}),
        OR: [
          { businessReminders: { some: { status: 'active' } } },
          { remindersWeeklyDigest: true },
        ],
      },
      select: {
        id: true,
        name: true,
        timezone: true,
        remindersWeeklyDigest: true,
        remindersDigestLastDate: true,
      },
    });
    let notices = 0;
    let digests = 0;
    for (const t of tenants) {
      const { hour, weekday } = localParts(t.timezone, now);
      if (hour < SEND_HOUR) continue;
      if (!(await tenantFeatures(this.admin, t.id)).includes('business_reminders')) continue;
      const today = dateStr(todayInTimezone(t.timezone, now));
      try {
        notices += await this.noticesForTenant(t, today);
        if (t.remindersWeeklyDigest && weekday === 1) {
          digests += await this.digestForTenant(t, today);
        }
      } catch (err) {
        this.logger.warn(
          `[business-reminders] tenant ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { notices, digests };
  }

  private async noticesForTenant(
    tenant: { id: string; name: string; timezone: string },
    today: string,
  ): Promise<number> {
    const reminders = await this.admin.businessReminder.findMany({
      where: { tenantId: tenant.id, status: 'active' },
      include: { facility: { select: { name: true } } },
    });
    let sent = 0;
    for (const r of reminders) {
      const due = dateStr(r.dueDate);
      const kind = reminderNoticeKind({
        dueDate: due,
        today,
        notifyDaysBefore: r.notifyDaysBefore,
        overdueReminders: r.overdueReminders,
        overdueMaxDays: r.overdueMaxDays,
        snoozedUntil: r.snoozedUntil ? dateStr(r.snoozedUntil) : null,
      });
      if (!kind) continue;
      try {
        await this.admin.businessReminderNotice.create({
          data: { tenantId: tenant.id, reminderId: r.id, dueDate: r.dueDate, kind },
        });
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
      await this.deliver(tenant, r, daysBetween(today, due));
      sent += 1;
    }
    return sent;
  }

  /** Personas del equipo que reciben el aviso. */
  private async recipients(
    tenantId: string,
    r: Pick<ReminderForNotice, 'recipientMode' | 'recipientUserIds' | 'facilityId'>,
  ): Promise<Recipient[]> {
    const users = await this.admin.user.findMany({
      where: {
        tenantId,
        isActive: true,
        ...(r.recipientMode === 'users'
          ? { id: { in: r.recipientUserIds } }
          : { role: { in: ['owner', 'manager'] } }),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        emailVerifiedAt: true,
        facilities: { select: { facilityId: true } },
      },
    });
    return users
      .filter(
        (u) =>
          r.recipientMode === 'users' ||
          !r.facilityId ||
          u.facilities.length === 0 ||
          u.facilities.some((f) => f.facilityId === r.facilityId),
      )
      .map((u) => ({ id: u.id, email: u.emailVerifiedAt ? u.email : '', fullName: u.fullName }));
  }

  private async deliver(
    tenant: { id: string; name: string; timezone: string },
    r: ReminderForNotice,
    daysLeft: number,
  ): Promise<void> {
    const when = reminderWhenLabel(daysLeft);
    const people = await this.recipients(tenant.id, r);
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    const url = `${base}/reminders?reminder=${r.id}`;
    const dateLong = formatDateLong(r.dueDate, tenant.timezone);
    const facts = [
      `Fecha: ${dateLong}`,
      r.facility ? `Local: ${r.facility.name}` : null,
      r.amount !== null ? `Importe: ${formatEur(r.amount)}` : null,
      r.vendor ? `Proveedor: ${r.vendor}` : null,
      r.link ? `Enlace: ${r.link}` : null,
      r.notes ? `Notas: ${r.notes}` : null,
    ].filter((l): l is string => !!l);

    if (r.notifyInApp || r.notifyPush) {
      for (const p of people) {
        await this.notifications
          .create(tenant.id, {
            type: r.notifyPush ? 'business_reminder.due' : 'business_reminder.notice',
            title: `${r.title}: ${when.toLowerCase()}`,
            body: facts.slice(0, 3).join(' · '),
            link: `/reminders?reminder=${r.id}`,
            facilityId: r.facilityId,
            userId: p.id,
          })
          .catch((err) =>
            this.logger.warn(`[business-reminders] aviso: ${(err as Error).message}`),
          );
      }
    }

    if (!r.notifyEmail) return;
    const subject = `${r.title} — ${when.toLowerCase()}`;
    const list = `<ul style="font-size:15px;line-height:22px;padding-left:18px">${facts
      .map((l) => `<li>${escapeHtml(l)}</li>`)
      .join('')}</ul>`;
    for (const p of people) {
      if (!p.email) continue;
      const text = [
        `Hola, ${p.fullName}.`,
        `${r.title}: ${when.toLowerCase()}.`,
        ...facts,
        `Ver vencimientos: ${url}`,
      ].join('\n\n');
      const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;max-width:560px">
<p style="font-size:13px;color:#64748b">${escapeHtml(tenant.name)}</p>
<h2 style="font-size:18px">${escapeHtml(r.title)}: ${escapeHtml(when.toLowerCase())}</h2>
${list}
<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Ver el vencimiento</a></p>
<p style="font-size:12px;color:#94a3b8">Lo marcas como hecho o lo pospones desde el panel.</p>
</div>`;
      await this.emailQueue.add(JOB_EMAIL_SEND, {
        to: p.email.toLowerCase(),
        kind: 'staff_notice',
        subject,
        html,
        text,
      });
    }
    // Fuera del equipo (asesoría…): desde el remitente del negocio y sin enlace al panel.
    for (const to of r.extraEmails) {
      const text = [`${r.title}: ${when.toLowerCase()}.`, ...facts, tenant.name].join('\n\n');
      await this.email
        .sendRendered({
          tenantId: tenant.id,
          to,
          subject: `${subject} · ${tenant.name}`,
          text,
          html: tenantEmailShell(
            { name: tenant.name, logoUrl: null, brandColor: null },
            `<p><strong>${escapeHtml(r.title)}</strong>: ${escapeHtml(when.toLowerCase())}.</p>${list}`,
          ),
        })
        .catch((err) =>
          this.logger.warn(`[business-reminders] externo: ${(err as Error).message}`),
        );
    }
  }

  /** Resumen de los lunes: lo vencido y lo que vence en los próximos 7 días. */
  private async digestForTenant(
    tenant: { id: string; name: string; timezone: string },
    today: string,
  ): Promise<number> {
    const day = new Date(`${today}T00:00:00Z`);
    const claimed = await this.admin.tenant.updateMany({
      where: {
        id: tenant.id,
        OR: [{ remindersDigestLastDate: null }, { remindersDigestLastDate: { lt: day } }],
      },
      data: { remindersDigestLastDate: day },
    });
    if (claimed.count === 0) return 0;
    const limit = new Date(day);
    limit.setUTCDate(limit.getUTCDate() + 7);
    const due = await this.admin.businessReminder.findMany({
      where: { tenantId: tenant.id, status: 'active', dueDate: { lte: limit } },
      include: { facility: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
    });
    if (due.length === 0) return 0;
    const people = await this.recipients(tenant.id, {
      recipientMode: 'managers',
      recipientUserIds: [],
      facilityId: null,
    });
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    let queued = 0;
    for (const p of people) {
      if (!p.email) continue;
      const scopeUser = await this.admin.user.findUnique({
        where: { id: p.id },
        select: { facilities: { select: { facilityId: true } } },
      });
      const allowed = scopeUser?.facilities.map((f) => f.facilityId) ?? [];
      const mine = due.filter(
        (r) => !r.facilityId || allowed.length === 0 || allowed.includes(r.facilityId),
      );
      if (mine.length === 0) continue;
      const lines = mine.map((r) => {
        const left = daysBetween(today, dateStr(r.dueDate));
        return `${r.title} — ${reminderWhenLabel(left).toLowerCase()}${r.facility ? ` (${r.facility.name})` : ''}`;
      });
      const url = `${base}/reminders`;
      await this.emailQueue.add(JOB_EMAIL_SEND, {
        to: p.email.toLowerCase(),
        kind: 'staff_notice',
        subject: `Vencimientos de esta semana en ${tenant.name}: ${mine.length}`,
        text: [`Hola, ${p.fullName}.`, ...lines, `Ver vencimientos: ${url}`].join('\n\n'),
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;max-width:560px">
<p style="font-size:13px;color:#64748b">${escapeHtml(tenant.name)}</p>
<h2 style="font-size:18px">Vencimientos de esta semana</h2>
<ul style="font-size:15px;line-height:22px;padding-left:18px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Ver vencimientos</a></p>
<p style="font-size:12px;color:#94a3b8">Puedes apagar este resumen en Vencimientos → Ajustes.</p>
</div>`,
      });
      queued += 1;
    }
    return queued;
  }
}
