import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { QUEUE_BILLING } from '../queues/queues.module';

import { AccessCredentialsController } from './access-credentials.controller';
import { AccessCredentialsService } from './access-credentials.service';
import { AccessDevicesController } from './access-devices.controller';
import { AccessDevicesService } from './access-devices.service';
import { AccessIntegrationsService } from './access-integrations.service';
import { AccessLogsController } from './access-logs.controller';
import { AccessRateLimitService } from './access-rate-limit.service';
import { AccessVerifyController } from './access-verify.controller';
import { AccessVerifyService } from './access-verify.service';
import { HttpLockProvider } from './providers/http-lock.provider';
import { LOCK_PROVIDER } from './providers/lock-provider';
import { MqttLockProvider } from './providers/mqtt-lock.provider';
import { StubLockProvider } from './providers/stub-lock.provider';

import type { Env } from '../../config/env.schema';

@Module({
  // La cola de billing solo se registra para obtener su conexión ioredis
  // (`queue.client`) — el rate-limit de accesos guarda sus contadores en Redis.
  imports: [AuthModule, BullModule.registerQueue({ name: QUEUE_BILLING })],
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
    AccessRateLimitService,
    AccessIntegrationsService,
    StubLockProvider,
    MqttLockProvider,
    HttpLockProvider,
    {
      provide: LOCK_PROVIDER,
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubLockProvider,
        mqtt: MqttLockProvider,
        http: HttpLockProvider,
      ) => {
        const provider = config.get('LOCK_PROVIDER', { infer: true });
        if (provider === 'mqtt') return mqtt;
        if (provider === 'http') return http;
        return stub;
      },
      inject: [ConfigService, StubLockProvider, MqttLockProvider, HttpLockProvider],
    },
  ],
  exports: [AccessCredentialsService, AccessIntegrationsService],
})
export class AccessModule {}
