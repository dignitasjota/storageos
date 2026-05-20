import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailService } from './email.service';
import { EMAIL_PROVIDER } from './providers/email-provider';
import { ResendEmailProvider } from './providers/resend.provider';
import { SmtpEmailProvider } from './providers/smtp.provider';

import type { Env } from '../../config/env.schema';

/**
 * EmailModule. El provider concreto se resuelve a partir de
 * `EMAIL_PROVIDER` (smtp por defecto en dev/test; resend en prod). Ambas
 * implementaciones se registran como providers de NestJS y el factory
 * decide cual exponer bajo el token `EMAIL_PROVIDER`.
 */
@Global()
@Module({
  providers: [
    SmtpEmailProvider,
    ResendEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useFactory: (
        config: ConfigService<Env, true>,
        smtp: SmtpEmailProvider,
        resend: ResendEmailProvider,
      ) => {
        const mode = config.get('EMAIL_PROVIDER', { infer: true });
        return mode === 'resend' ? resend : smtp;
      },
      inject: [ConfigService, SmtpEmailProvider, ResendEmailProvider],
    },
    EmailService,
  ],
  exports: [EmailService, EMAIL_PROVIDER],
})
export class EmailModule {}
