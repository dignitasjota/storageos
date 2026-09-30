import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { BrevoDomainsClient } from './brevo-domains.client';
import { DomainOwnershipChecker } from './domain-ownership.checker';
import { EmailDomainsController } from './email-domains.controller';
import { EmailDomainsCron } from './email-domains.cron';
import { EmailDomainsService } from './email-domains.service';

/** Dominio propio de correo del tenant (Brevo de la plataforma). */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [EmailDomainsController],
  providers: [
    BrevoDomainsClient,
    DomainOwnershipChecker,
    EmailDomainsService,
    ...(WORKERS_ENABLED_IN_API ? [EmailDomainsCron] : []),
  ],
  exports: [EmailDomainsService],
})
export class EmailDomainsModule {}
