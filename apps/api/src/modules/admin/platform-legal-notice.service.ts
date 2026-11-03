import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { renderAdminEmail } from '@storageos/shared';
import { Queue } from 'bullmq';

import {
  PLATFORM_LEGAL_PUBLISHED,
  type PlatformLegalPublishedEvent,
} from '../platform/platform.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { AdminSegmentService } from './admin-segment.service';

import type { Env } from '../../config/env.schema';
import type { EmailSendJobData } from '../email/email-send.processor';

const PUBLIC_PATH: Record<string, string> = {
  terms: '/terminos',
  privacy: '/privacidad',
  cookies: '/cookies',
  'data-deletion': '/eliminar-datos',
};

/**
 * Cuando el super admin publica una versión de un texto legal pidiendo que se
 * acepte, avisa por correo a los propietarios de los tenants activos y en
 * prueba (es un aviso de servicio: no lleva baja). En su panel ven un aviso
 * con el botón para aceptarla.
 */
@Injectable()
export class PlatformLegalNoticeService {
  private readonly logger = new Logger(PlatformLegalNoticeService.name);
  private readonly webBase: string;

  constructor(
    private readonly segments: AdminSegmentService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.webBase = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  @OnEvent(PLATFORM_LEGAL_PUBLISHED, { async: true })
  async onPublished(e: PlatformLegalPublishedEvent): Promise<void> {
    try {
      const tenants = await this.segments.tenantsFor({ audience: 'all' });
      const recipients = await this.segments.recipientsFor(tenants, false);
      if (recipients.length === 0) return;
      const url = `${this.webBase}${PUBLIC_PATH[e.slug] ?? '/'}`;
      const subject = `Hemos actualizado: ${e.title}`;
      const mail = renderAdminEmail(
        [
          `Hola, hemos actualizado **${e.title}** de TrasterOS.`,
          `Puedes leer el texto completo aquí: [${url}](${url})`,
          'Al entrar en tu panel verás un aviso para aceptarlo. Si tienes cualquier duda, responde a este correo.',
        ].join('\n\n'),
      );
      await this.emailQueue.addBulk(
        recipients.map((r) => ({
          name: JOB_EMAIL_SEND,
          data: {
            to: r.email,
            kind: 'admin_message',
            subject,
            html: mail.html,
            text: mail.text,
          } satisfies EmailSendJobData,
        })),
      );
      this.logger.log(`[legal] aviso de «${e.title}» a ${recipients.length} destinatarios`);
    } catch (err) {
      this.logger.error(`[legal] aviso de cambio: ${err instanceof Error ? err.message : err}`);
    }
  }
}
