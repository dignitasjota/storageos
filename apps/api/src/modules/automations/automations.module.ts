import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { AutomationsController } from './automations.controller';
import { AutomationsProcessor } from './automations.processor';
import { AutomationsService } from './automations.service';

/**
 * Sub-bloque 14A.1: `AutomationsProcessor` solo se registra cuando
 * `ENABLE_WORKERS_IN_API=true`. `AutomationsService` sigue siempre
 * activo (otros modulos pueden inyectar para encolar reglas).
 */
@Module({
  imports: [AuthModule],
  controllers: [AutomationsController],
  providers: [AutomationsService, ...(WORKERS_ENABLED_IN_API ? [AutomationsProcessor] : [])],
  exports: [AutomationsService],
})
export class AutomationsModule {}
