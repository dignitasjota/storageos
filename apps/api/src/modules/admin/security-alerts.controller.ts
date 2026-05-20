import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { SecurityAlertsService } from '../security-events/security-alerts.service';

import { AdminGuard } from './admin.guard';

/**
 * Endpoint manual de scan de alertas de brute-force. Permite al super admin
 * forzar una ejecucion del agregado sin esperar al cron de 5 minutos.
 *
 * `@Public()` salta el `JwtAuthGuard` global (que valida tokens de tenant);
 * la autorizacion la hace `AdminGuard` con `SUPER_ADMIN_JWT_SECRET`.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/security-alerts')
export class SecurityAlertsController {
  constructor(private readonly alerts: SecurityAlertsService) {}

  @Post('scan')
  @HttpCode(200)
  async scan(): Promise<{ alertsSent: number }> {
    return this.alerts.scanAndAlert();
  }
}
