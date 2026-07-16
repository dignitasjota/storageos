import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
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
import { DahuaReconcileCron } from './dahua-reconcile.cron';
import { DahuaSyncService } from './dahua-sync.service';
import { DahuaLockProvider } from './providers/dahua-lock.provider';
import { DahuaSyncProvider } from './providers/dahua-sync.provider';
import { HttpLockProvider } from './providers/http-lock.provider';
import { LockProviderRegistry } from './providers/lock-provider.registry';
import { MqttLockProvider } from './providers/mqtt-lock.provider';
import { StubLockProvider } from './providers/stub-lock.provider';
import { StubSyncProvider } from './providers/stub-sync.provider';
import { SyncProviderRegistry } from './providers/sync-provider.registry';

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
    // Todos los adapters de cerradura; el registry elige por-device (o por env).
    StubLockProvider,
    MqttLockProvider,
    HttpLockProvider,
    DahuaLockProvider,
    LockProviderRegistry,
    // Sincronización de credenciales (Patrón B) + reconciliación de logs.
    StubSyncProvider,
    DahuaSyncProvider,
    SyncProviderRegistry,
    DahuaSyncService,
    ...(WORKERS_ENABLED_IN_API ? [DahuaReconcileCron] : []),
  ],
  exports: [AccessCredentialsService, AccessIntegrationsService, AccessVerifyService],
})
export class AccessModule {}
