import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CollectionsListenersService } from './collections-listeners.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';

/**
 * Expedientes de impago (overlock → requerimiento → disposición). Orquesta el
 * expediente con compuertas manuales; nunca dispone solo. `FilesService`
 * (evidencias) y `PrismaAdminService` son globales; `AuthModule` aporta
 * `AuditService`.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [CollectionsController],
  providers: [CollectionsService, CollectionsListenersService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
