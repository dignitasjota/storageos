import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CameraDevicesService } from './camera-devices.service';
import { CameraEventsService } from './camera-events.service';
import { CameraIngestController } from './camera-ingest.controller';
import { CamerasController } from './cameras.controller';

/**
 * Cámaras de seguridad + alarma (AirShield): ingesta de EVENTOS + SNAPSHOTS.
 * El vídeo en vivo/grabado se deja a la app oficial de Dahua (DMSS). La ingesta
 * es agnóstica del origen (push del equipo, agente on-site o puente DSS).
 * `FilesService` (snapshots) y `PrismaAdminService` (ingesta cross-tenant) son
 * globales; `AuthModule` aporta `AuditService`.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [CamerasController, CameraIngestController],
  providers: [CameraDevicesService, CameraEventsService],
})
export class CamerasModule {}
