import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';

import { AccessCredentialsController } from './access-credentials.controller';
import { AccessCredentialsService } from './access-credentials.service';
import { AccessDevicesController } from './access-devices.controller';
import { AccessDevicesService } from './access-devices.service';
import { AccessIntegrationsService } from './access-integrations.service';
import { AccessLogsController } from './access-logs.controller';
import { AccessVerifyController } from './access-verify.controller';
import { AccessVerifyService } from './access-verify.service';
import { LOCK_PROVIDER } from './providers/lock-provider';
import { MqttLockProvider } from './providers/mqtt-lock.provider';
import { StubLockProvider } from './providers/stub-lock.provider';

import type { Env } from '../../config/env.schema';

@Module({
  imports: [AuthModule],
  controllers: [
    AccessCredentialsController,
    AccessDevicesController,
    AccessVerifyController,
    AccessLogsController,
  ],
  providers: [
    AccessCredentialsService,
    AccessDevicesService,
    AccessVerifyService,
    AccessIntegrationsService,
    StubLockProvider,
    MqttLockProvider,
    {
      provide: LOCK_PROVIDER,
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubLockProvider,
        mqtt: MqttLockProvider,
      ) => (config.get('LOCK_PROVIDER', { infer: true }) === 'mqtt' ? mqtt : stub),
      inject: [ConfigService, StubLockProvider, MqttLockProvider],
    },
  ],
  exports: [AccessCredentialsService, AccessIntegrationsService],
})
export class AccessModule {}
