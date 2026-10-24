import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { UpdateRedsysSettingsSchema, type RedsysSettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminAudit } from '../../admin/admin-audit.decorator';
import { AdminGuard } from '../../admin/admin.guard';
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';

import { PlatformRedsysService } from './platform-redsys.service';

import type { Request } from 'express';

class UpdatePlatformRedsysSettingsDto extends createZodDto(UpdateRedsysSettingsSchema) {}

/** TPV virtual (Redsys) de la plataforma. Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform-redsys')
export class PlatformRedsysController {
  constructor(private readonly redsys: PlatformRedsysService) {}

  @Get('settings')
  getSettings(): Promise<RedsysSettingsDto> {
    return this.redsys.getSettings();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform_redsys.settings_updated')
  @Put('settings')
  updateSettings(@Body() body: UpdatePlatformRedsysSettingsDto): Promise<RedsysSettingsDto> {
    return this.redsys.updateSettings(body);
  }
}

/**
 * Aviso servidor a servidor de Redsys para los pagos de suscripción (el de los
 * tenants es `/webhooks/redsys`). Cuerpo crudo (middleware de `/webhooks/redsys`
 * en `main.ts`): urlencoded en Redsys, JSON en los tests.
 */
@Public()
@Controller({ path: 'webhooks/redsys/platform', version: VERSION_NEUTRAL })
export class PlatformRedsysWebhookController {
  constructor(private readonly redsys: PlatformRedsysService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<{ received: true }> {
    const body = req.body as Buffer | Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    let fields: { Ds_MerchantParameters?: string | undefined; Ds_Signature?: string | undefined };
    if (Buffer.isBuffer(body)) {
      const text = body.toString('utf8');
      if ((req.headers['content-type'] ?? '').includes('application/json')) {
        const json = JSON.parse(text) as Record<string, unknown>;
        fields = {
          Ds_MerchantParameters: str(json['Ds_MerchantParameters']),
          Ds_Signature: str(json['Ds_Signature']),
        };
      } else {
        const params = new URLSearchParams(text);
        fields = {
          Ds_MerchantParameters: params.get('Ds_MerchantParameters') ?? undefined,
          Ds_Signature: params.get('Ds_Signature') ?? undefined,
        };
      }
    } else {
      const b = body ?? {};
      fields = {
        Ds_MerchantParameters: str(b['Ds_MerchantParameters']),
        Ds_Signature: str(b['Ds_Signature']),
      };
    }
    await this.redsys.handleNotification(fields);
    return { received: true };
  }
}
