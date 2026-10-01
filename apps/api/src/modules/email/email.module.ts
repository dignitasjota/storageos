import { Global, Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { EmailSendProcessor } from './email-send.processor';
import { EmailSuppressionsService } from './email-suppressions.service';
import { EmailService } from './email.service';
import { PlatformEmailSettingsService } from './platform-email-settings.service';
import { BrevoEmailProvider } from './providers/brevo.provider';
import { EMAIL_PROVIDER } from './providers/email-provider';
import { ResendEmailProvider } from './providers/resend.provider';
import { RoutingEmailProvider } from './providers/routing.provider';
import { SmtpEmailProvider } from './providers/smtp.provider';
import { TenantSenderService } from './tenant-sender.service';

/**
 * EmailModule. Bajo el token `EMAIL_PROVIDER` se expone el enrutador, que en
 * cada envío elige SMTP / Brevo / Resend: el ajuste del panel del super admin
 * manda si el proveedor tiene su clave; si no, la variable `EMAIL_PROVIDER`
 * (smtp/Mailpit en dev y test).
 */
@Global()
@Module({
  providers: [
    SmtpEmailProvider,
    ResendEmailProvider,
    BrevoEmailProvider,
    PlatformEmailSettingsService,
    RoutingEmailProvider,
    { provide: EMAIL_PROVIDER, useExisting: RoutingEmailProvider },
    EmailService,
    EmailSuppressionsService,
    TenantSenderService,
    // Solo procesa jobs cuando los workers corren en este proceso (worker en
    // prod; API en dev/test). El `EmailService` sigue disponible siempre.
    ...(WORKERS_ENABLED_IN_API ? [EmailSendProcessor] : []),
  ],
  exports: [
    EmailService,
    EmailSuppressionsService,
    TenantSenderService,
    PlatformEmailSettingsService,
    EMAIL_PROVIDER,
  ],
})
export class EmailModule {}
