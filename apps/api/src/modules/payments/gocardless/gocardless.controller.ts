import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import {
  GoCardlessMandateCompleteSchema,
  type GoCardlessMandateStartDto,
  GoCardlessMandateStartSchema,
  type GoCardlessSettingsDto,
  type GoCardlessTestResultDto,
  type PaymentMethodDto,
  UpdateGoCardlessSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { GoCardlessClient } from './gocardless-client';
import { GoCardlessMandatesService } from './gocardless-mandates.service';
import { GoCardlessSettingsService } from './gocardless-settings.service';

import type { RequestMeta } from '../../auth/auth.service';
import type { Request } from 'express';

class UpdateGoCardlessSettingsBody extends createZodDto(UpdateGoCardlessSettingsSchema) {}
class GoCardlessMandateStartBody extends createZodDto(GoCardlessMandateStartSchema) {}
class GoCardlessMandateCompleteBody extends createZodDto(GoCardlessMandateCompleteSchema) {}

/** Ruta del frontend a la que GoCardless devuelve al staff tras autorizar. */
const STAFF_RETURN_PATH = '/pay/gocardless/complete';

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('settings/gocardless')
export class GoCardlessController {
  constructor(
    private readonly settings: GoCardlessSettingsService,
    private readonly client: GoCardlessClient,
    private readonly mandates: GoCardlessMandatesService,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<GoCardlessSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateGoCardlessSettingsBody,
  ): Promise<GoCardlessSettingsDto> {
    return this.settings.update(user.tenantId, body);
  }

  /** Prueba la conexión con el access token guardado (lista los creditors). */
  @RequirePermission('billing:configure')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async test(@CurrentUser() user: AuthenticatedUser): Promise<GoCardlessTestResultDto> {
    const resolved = await this.settings.getResolved(user.tenantId);
    if (!resolved) {
      return { ok: false, creditorName: null, error: 'no_access_token' };
    }
    return this.client.testConnection(resolved.accessToken, resolved.environment);
  }

  /** Staff: inicia el mandato de un inquilino → URL de autorización. */
  @RequirePermission('payments:charge')
  @Post('mandate/start')
  @HttpCode(HttpStatus.OK)
  startMandate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: GoCardlessMandateStartBody,
  ): Promise<GoCardlessMandateStartDto> {
    return this.mandates.startFlow({
      tenantId: user.tenantId,
      customerId: body.customerId,
      returnPath: STAFF_RETURN_PATH,
    });
  }

  /** Staff: completa el mandato tras la autorización → registra el método de pago. */
  @RequirePermission('payments:charge')
  @Post('mandate/complete')
  @HttpCode(HttpStatus.OK)
  completeMandate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: GoCardlessMandateCompleteBody,
    @Req() req: Request,
  ): Promise<PaymentMethodDto> {
    return this.mandates.completeFlow({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: body.customerId,
      billingRequestId: body.billingRequestId,
      meta: extractMeta(req),
    });
  }
}
