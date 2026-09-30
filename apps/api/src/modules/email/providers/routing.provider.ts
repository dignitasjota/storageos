import { Injectable, Logger } from '@nestjs/common';

import {
  PlatformEmailSettingsService,
  type EmailProviderKey,
} from '../platform-email-settings.service';

import { BrevoEmailProvider } from './brevo.provider';
import { EmailProvider, type SendEmailArgs, type SendEmailResult } from './email-provider';
import { ResendEmailProvider } from './resend.provider';
import { SmtpEmailProvider } from './smtp.provider';

/**
 * Proveedor que se expone bajo `EMAIL_PROVIDER`: en cada envío decide entre
 * SMTP, Brevo y Resend según el ajuste del panel de super admin, y si el
 * principal falla y el respaldo está activo, reintenta con el siguiente.
 */
@Injectable()
export class RoutingEmailProvider extends EmailProvider {
  private readonly logger = new Logger(RoutingEmailProvider.name);

  constructor(
    private readonly settings: PlatformEmailSettingsService,
    private readonly smtp: SmtpEmailProvider,
    private readonly brevo: BrevoEmailProvider,
    private readonly resend: ResendEmailProvider,
  ) {
    super();
  }

  get name(): string {
    return 'auto';
  }

  async close(): Promise<void> {
    await this.smtp.close();
  }

  async send(args: SendEmailArgs): Promise<SendEmailResult> {
    const order = await this.settings.sendOrder(args.forceProvider);
    let lastError: unknown = null;
    for (const [i, key] of order.entries()) {
      try {
        const res = await this.byKey(key).send(args);
        if (i > 0) {
          this.logger.warn(`Correo a ${args.to} enviado por el respaldo (${key})`);
        }
        return { ...res, provider: key };
      } catch (err) {
        lastError = err;
        if (i < order.length - 1) {
          this.logger.warn(
            `Falló el envío por ${key} (${err instanceof Error ? err.message : err}); probando ${order[i + 1]}`,
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private byKey(key: EmailProviderKey): EmailProvider {
    if (key === 'brevo') return this.brevo;
    if (key === 'resend') return this.resend;
    return this.smtp;
  }
}
