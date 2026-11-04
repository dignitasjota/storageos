import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTodayService } from './admin-today.service';
import { claimAlert } from './alert-state';
import { ChatAlertsService } from './chat-alerts.service';

/** El mismo asunto no se repite antes de un día. */
const REPEAT_MINUTES = 24 * 60;
const MAX_LINES = 15;

/**
 * Avisa al momento de lo urgente que aparece en «Hoy»: un ticket urgente, un
 * pago pendiente nuevo o un dispositivo de acceso sin conexión. Lo demás espera
 * al aviso diario.
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
    const candidates: [string, string][] = [
      ...t.openTickets
        .filter((k) => k.priority === 'urgent' || k.priority === 'high')
        .map((k): [string, string] => [
          `ticket:${k.id}`,
          `Ticket de ${k.tenantName}: ${k.subject}`,
        ]),
      ...t.pastDue.map((p): [string, string] => [
        `past_due:${p.id}`,
        `${p.name} tiene un pago pendiente`,
      ]),
      ...t.devicesOffline.map((d): [string, string] => [
        `device:${d.tenantId}`,
        `${d.tenantName}: ${d.count} dispositivo(s) de acceso sin conexión`,
      ]),
    ];
    const lines: string[] = [];
    for (const [identifier, line] of candidates) {
      if (await claimAlert(this.admin, 'today', identifier, REPEAT_MINUTES)) lines.push(line);
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
