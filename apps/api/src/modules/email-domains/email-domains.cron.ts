import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { EmailDomainsService } from './email-domains.service';

/**
 * Revisión diaria de los dominios de correo de los tenants (verifica los
 * pendientes y detecta los que se han roto). Solo con `ENABLE_WORKERS_IN_API`
 * (corre en el worker en producción).
 */
@Injectable()
export class EmailDomainsCron {
  private readonly logger = new Logger(EmailDomainsCron.name);

  constructor(private readonly service: EmailDomainsService) {}

  @Cron('30 6 * * *', { name: 'email-domains.recheck' })
  async run(): Promise<void> {
    try {
      const res = await this.service.recheckAll();
      if (res.checked > 0) {
        this.logger.log(
          `Dominios de correo revisados: ${res.checked} (verificados ${res.verified}, rotos ${res.failed})`,
        );
      }
    } catch (err) {
      this.logger.error(`Revisión de dominios de correo falló: ${String(err)}`);
    }
  }
}
