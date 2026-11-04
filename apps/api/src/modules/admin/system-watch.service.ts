import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { QUEUE_BILLING } from '../queues/queues.module';
import { WORKERS_HEARTBEAT_KEY } from '../queues/workers-heartbeat.cron';

import { AdminOpsHealthService } from './admin-ops-health.service';
import { ChatAlertsService } from './chat-alerts.service';
import { PlatformAlertsService } from './platform-alerts.service';

/** A partir de cuánto retraso una tarea merece un aviso. */
const CRON_LATE_MS = 60 * 60 * 1000;
/** No se repite el aviso del mismo problema antes de este plazo. */
const REPEAT_MINUTES = 6 * 60;

/**
 * Avisa por los canales del super admin si el worker no late o una tarea lleva
 * más de una hora atrasada. Antes solo se veía entrando en Sistema y colas.
 */
@Injectable()
export class SystemWatchService {
  private readonly logger = new Logger(SystemWatchService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly ops: AdminOpsHealthService,
    private readonly chat: ChatAlertsService,
    private readonly platformAlerts: PlatformAlertsService,
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
  ) {}

  async check(now = new Date()): Promise<{ problems: string[] }> {
    const problems: string[] = [];
    const client = await this.queue.client;
    if (!(await client.get(WORKERS_HEARTBEAT_KEY))) {
      if (await this.claim('worker')) problems.push('El worker no da señales de vida.');
    }
    for (const cron of await this.ops.crons(now)) {
      const next = cron.nextRunAt ? new Date(cron.nextRunAt).getTime() : null;
      if (!cron.overdue || next === null || now.getTime() - next < CRON_LATE_MS) continue;
      if (await this.claim(cron.name)) {
        problems.push(`La tarea ${cron.name} lleva más de una hora atrasada.`);
      }
    }
    if (problems.length > 0) await this.notify(problems);
    return { problems };
  }

  private async claim(identifier: string): Promise<boolean> {
    const rows = await this.admin.$queryRaw<Array<{ kind: string }>>`
      INSERT INTO security_alert_states (kind, identifier, last_sent_at)
      VALUES ('system', ${identifier}, now())
      ON CONFLICT (kind, identifier) DO UPDATE SET last_sent_at = now()
      WHERE security_alert_states.last_sent_at < now() - make_interval(mins => ${REPEAT_MINUTES}::int)
      RETURNING kind`;
    return rows.length > 0;
  }

  private async notify(problems: string[]): Promise<void> {
    const title = 'Hay que revisar el sistema';
    const body = problems.join('\n');
    await this.admin.superAdminNotification.create({
      data: { type: 'system.attention', title, body, link: '/admin/queues' },
    });
    await this.chat.send(`⚠️ ${title}\n${body}`, 'system').catch((err: unknown) => {
      this.logger.warn(`Aviso del sistema por chat: ${(err as Error).message}`);
    });
    await this.platformAlerts
      .emailAdmins({
        kind: 'system',
        subject: `[TrasterOS] ${title}`,
        html: `<p>${problems.join('<br>')}</p>`,
        text: body,
      })
      .catch((err: unknown) => {
        this.logger.warn(`Aviso del sistema por correo: ${(err as Error).message}`);
      });
  }
}
