import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { NotificationsModule } from '../notifications/notifications.module';

import { InventoryReconciliationCron } from './inventory-reconciliation.cron';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [NotificationsModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    // El cron solo se monta donde corren los workers (worker en prod).
    ...(WORKERS_ENABLED_IN_API ? [InventoryReconciliationCron] : []),
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
