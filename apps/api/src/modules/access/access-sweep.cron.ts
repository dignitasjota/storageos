import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AccessCredentialsService } from './access-credentials.service';
import { AccessDevicesService } from './access-devices.service';

/**
 * Repaso de las credenciales: marca lo caducado o gastado y lo saca de los
 * terminales, y retira lo que le quede a quien ya no tiene contratos.
 */
@Injectable()
export class AccessSweepCron {
  private readonly logger = new Logger(AccessSweepCron.name);

  constructor(
    private readonly credentials: AccessCredentialsService,
    private readonly devices: AccessDevicesService,
  ) {}

  @Cron('*/15 * * * *', { name: 'access.sweep' })
  async run(): Promise<void> {
    const { expired, revoked } = await this.credentials.sweep();
    if (expired + revoked > 0) {
      this.logger.log(`[access] ${expired} caducadas, ${revoked} revocadas de ex-inquilinos`);
    }
  }

  @Cron('*/10 * * * *', { name: 'access.device-health' })
  async health(): Promise<void> {
    await this.devices.checkAll();
  }
}
