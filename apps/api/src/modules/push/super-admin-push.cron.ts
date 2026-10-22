import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SuperAdminPushService } from './super-admin-push.service';

/** Cada minuto, los avisos nuevos del super admin salen por push. */
@Injectable()
export class SuperAdminPushCron {
  private readonly logger = new Logger(SuperAdminPushCron.name);

  constructor(private readonly push: SuperAdminPushService) {}

  @Cron('* * * * *', { name: 'super-admin-push.send' })
  async run(): Promise<void> {
    try {
      await this.push.sendPending();
    } catch (err) {
      this.logger.warn(`[super-admin-push] ${(err as Error).message}`);
    }
  }
}
