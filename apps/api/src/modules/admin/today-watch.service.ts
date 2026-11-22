import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTodayService } from './admin-today.service';
import { alertSentWithin, claimAlert, markAlertSent } from './alert-state';
import { ChatAlertsService } from './chat-alerts.service';

/** El mismo asunto no se repite antes de un día, aunque cambie. */
const REPEAT_MINUTES = 24 * 60;
/** Lo mismo, sin novedades, no se vuelve a avisar en este plazo. */
const SAME_STATE_MINUTES = 30 * 24 * 60;
const MAX_LINES = 15;

/** Un asunto (ticket, impago, dispositivos de un tenant) y cómo está ahora. */
interface WatchCandidate {
  subject: string;
  state: string;
  line: string;
}

/**
 * Avisa al momento de lo urgente que aparece en «Hoy»: un ticket urgente, un
 * pago pendiente nuevo o un dispositivo de acceso sin conexión. Lo demás espera
 * al aviso diario. Solo avisa cuando hay novedad (el cliente vuelve a escribir,
 * sube la deuda, caen más dispositivos) y, como mucho, una vez al día por asunto.
 */
@Injectable()
export class TodayWatchService {
  private readonly logger = new Logger(TodayWatchService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly today: AdminTodayService,
    private readonly chat: ChatAlertsService,
  ) {}

  async check(): Promise<{ lines: string[] }> {
    const settings = await this.admin.platformAlertSettings.findFirst();
    if (settings && !settings.instantAlertsEnabled) return { lines: [] };

    const t = await this.today.getToday();
    const candidates: WatchCandidate[] = [
      ...t.openTickets
        .filter((k) => k.priority === 'urgent' || k.priority === 'high')
        .map((k) => ({
          subject: `ticket:${k.id}`,
          state: k.lastTenantMessageAt,
          line: `Ticket de ${k.tenantName}: ${k.subject}`,
        })),
      ...t.pastDue.map((p) => ({
        subject: `past_due:${p.id}`,
        state: `${p.since ?? ''}|${p.owedPeriods ?? 0}|${p.owedAmount ?? 0}`,
        line: `${p.name} tiene un pago pendiente`,
      })),
      ...t.devicesOffline.map((d) => ({
        subject: `device:${d.tenantId}`,
        state: String(d.count),
        line: `${d.tenantName}: ${
          d.count === 1
            ? '1 dispositivo de acceso sin conexión'
            : `${d.count} dispositivos de acceso sin conexión`
        }`,
      })),
    ];
    const lines: string[] = [];
    for (const c of candidates) {
      const stateId = `${c.subject}@${c.state}`;
      // Ya se avisó de esto tal cual: no se repite cada día.
      if (await alertSentWithin(this.admin, 'today', stateId, SAME_STATE_MINUTES)) continue;
      // Hay novedad, pero el asunto ya avisó hace menos de un día: espera.
      if (!(await claimAlert(this.admin, 'today', c.subject, REPEAT_MINUTES))) continue;
      await markAlertSent(this.admin, 'today', stateId);
      lines.push(c.line);
    }
    if (lines.length > 0) await this.notify(lines);
    return { lines };
  }

  private async notify(lines: string[]): Promise<void> {
    const shown = lines.slice(0, MAX_LINES);
    if (lines.length > MAX_LINES) shown.push(`… y ${lines.length - MAX_LINES} más`);
    const title =
      lines.length === 1 ? 'Algo urgente en «Hoy»' : `${lines.length} urgentes en «Hoy»`;
    const body = shown.join('\n');
    await this.admin.superAdminNotification.create({
      data: { type: 'today.attention', title, body, link: '/admin/today' },
    });
    await this.chat.send(`🔔 ${title}\n${body}`, 'today').catch((err: unknown) => {
      this.logger.warn(`Aviso de «Hoy» por chat: ${(err as Error).message}`);
    });
  }
}
