import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../../../config/workers-enabled';

import { PlatformLeadMailService } from './platform-lead-mail.service';
import { PlatformLeadSequencesCron } from './platform-lead-sequences.cron';
import { PlatformLeadSequencesService } from './platform-lead-sequences.service';

/**
 * Lo de los leads del panel admin que también corre en el worker: el correo a
 * un lead (con su dirección de respuesta) y las secuencias automáticas. Módulo
 * ligero (sin controllers) para que lo importen `AdminModule` y el worker; el
 * cron solo se registra con `ENABLE_WORKERS_IN_API=true`.
 */
@Module({
  providers: [
    PlatformLeadMailService,
    PlatformLeadSequencesService,
    ...(WORKERS_ENABLED_IN_API ? [PlatformLeadSequencesCron] : []),
  ],
  exports: [PlatformLeadMailService, PlatformLeadSequencesService],
})
export class PlatformLeadsCoreModule {}
