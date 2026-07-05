import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { type TenantLifecycleRunResultDto } from '@storageos/shared';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

/**
 * Disparo manual de los emails de ciclo de vida al tenant («ejecutar ahora»,
 * útil para probar sin esperar al cron). Restringido al rol `superadmin` porque
 * envía correos a clientes.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/tenant-lifecycle')
export class TenantLifecycleEmailsController {
  constructor(private readonly lifecycle: TenantLifecycleEmailsService) {}

  @Post('run')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  async run(): Promise<TenantLifecycleRunResultDto> {
    return this.lifecycle.run();
  }
}
