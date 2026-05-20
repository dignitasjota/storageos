import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SecurityAlertsService } from './security-alerts.service';

/**
 * Cron que ejecuta `SecurityAlertsService.scanAndAlert` cada 5 minutos.
 * Aislado en su propia clase para mantener `SecurityAlertsService` sin
 * dependencias de `@nestjs/schedule` y facilitar tests unitarios.
 */
@Injectable()
export class SecurityAlertsCron {
  private readonly logger = new Logger(SecurityAlertsCron.name);

  constructor(private readonly alerts: SecurityAlertsService) {}

  @Cron('*/5 * * * *', { name: 'security-alerts.scan' })
  async runScan(): Promise<void> {
    try {
      const { alertsSent } = await this.alerts.scanAndAlert();
      if (alertsSent > 0) {
        this.logger.warn(`security-alerts.scan: ${alertsSent} alerta(s) enviada(s)`);
      }
    } catch (err) {
      this.logger.error(
        `security-alerts.scan fallo: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
