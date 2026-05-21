import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';
import { WebhooksService, type WebhookCleanupStats } from '../integrations/webhooks.service';

import { AdminGuard } from './admin.guard';

import type { Env } from '../../config/env.schema';

const RunCleanupSchema = z.object({
  /** Override del retention configurado por env. Útil para purga manual
   *  más agresiva tras un incidente. Si se omite usa el default del env. */
  olderThanDays: z.coerce.number().int().positive().optional(),
});

class RunCleanupDto extends createZodDto(RunCleanupSchema) {}

const StatsQuerySchema = z.object({
  olderThanDays: z.coerce.number().int().positive().optional(),
});
class StatsQueryDto extends createZodDto(StatsQuerySchema) {}

/**
 * Endpoint manual de purga de `webhook_deliveries`. Permite al super admin
 * forzar una ejecución del cleanup sin esperar al cron diario de 04:00.
 *
 * `@Public()` salta el `JwtAuthGuard` global; `AdminGuard` valida con
 * `SUPER_ADMIN_JWT_SECRET`.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/webhooks-cleanup')
export class WebhooksCleanupController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('stats')
  async stats(@Query() query: StatsQueryDto): Promise<WebhookCleanupStats> {
    const defaultRetention = this.config.get('WEBHOOK_DELIVERIES_RETENTION_DAYS', { infer: true });
    const olderThanDays: number = query.olderThanDays ?? defaultRetention;
    return this.webhooks.getCleanupStats(olderThanDays);
  }

  @Post('run')
  @HttpCode(200)
  async run(@Body() body: RunCleanupDto): Promise<{ deleted: number; olderThanDays: number }> {
    const defaultRetention = this.config.get('WEBHOOK_DELIVERIES_RETENTION_DAYS', { infer: true });
    const olderThanDays: number = body.olderThanDays ?? defaultRetention;
    const result = await this.webhooks.cleanupDeliveries(olderThanDays);
    return { ...result, olderThanDays };
  }
}
