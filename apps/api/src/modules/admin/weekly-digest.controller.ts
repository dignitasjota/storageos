import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { type AdminWeeklyDigestResultDto } from '@storageos/shared';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { WeeklyDigestService } from './weekly-digest.service';

/** Disparo manual del resumen semanal de KPIs («enviar ahora»). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/weekly-digest')
export class WeeklyDigestController {
  constructor(private readonly digest: WeeklyDigestService) {}

  @RequireSuperadmin()
  @Post('run')
  @HttpCode(HttpStatus.OK)
  async run(): Promise<AdminWeeklyDigestResultDto> {
    return this.digest.sendWeeklyDigest();
  }
}
