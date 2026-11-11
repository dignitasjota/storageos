import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ContractsModule } from '../contracts/contracts.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CollectionsListenersService } from './collections-listeners.service';
import { CollectionsRequirementPdfService } from './collections-requirement-pdf.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';

/**
 * Expedientes de impago (candado → requerimiento → contrato resuelto →
 * traslado y custodia → disposición por un cauce legal), según la condición 12
 * del contrato. Orquesta el expediente con compuertas manuales; nunca dispone
 * solo. `FilesService` (evidencias) y `PrismaAdminService` son globales;
 * `AuthModule` aporta `AuditService` y `ContractsModule` termina el contrato
 * al resolverlo.
 */
@Module({
  imports: [AuthModule, BillingModule, ContractsModule, NotificationsModule],
  controllers: [CollectionsController],
  providers: [CollectionsService, CollectionsListenersService, CollectionsRequirementPdfService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
