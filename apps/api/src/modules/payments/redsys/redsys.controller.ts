import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  type RedsysRedirectDto,
  RedsysRedirectRequestSchema,
  type RedsysSettingsDto,
  type RedsysTestResultDto,
  TestRedsysSettingsSchema,
  UpdateRedsysSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../../../common/decorators/require-permission.decorator';
import { settingsChanges } from '../../../common/settings-audit';
import { AuditService } from '../../auth/audit.service';

import { RedsysChargeService } from './redsys-charge.service';
import { RedsysSettingsService } from './redsys-settings.service';
import { RedsysService } from './redsys.service';

import type { Request } from 'express';

class UpdateRedsysSettingsBody extends createZodDto(UpdateRedsysSettingsSchema) {}
class RedsysRedirectBody extends createZodDto(RedsysRedirectRequestSchema) {}
class TestRedsysSettingsBody extends createZodDto(TestRedsysSettingsSchema) {}

@Controller('settings/redsys')
export class RedsysController {
  constructor(
    private readonly settings: RedsysSettingsService,
    private readonly redsys: RedsysService,
    private readonly audit: AuditService,
    private readonly charge: RedsysChargeService,
  ) {}

  @RequireAnyPermission('settings:read', 'billing:configure')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<RedsysSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateRedsysSettingsBody,
    @Req() req: Request,
  ): Promise<RedsysSettingsDto> {
    const before = await this.settings.get(user.tenantId);
    const after = await this.settings.update(user.tenantId, body);
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action: 'settings.redsys_changed',
      entityType: 'RedsysSettings',
      entityId: null,
      changes: settingsChanges(before, after, { secretKey: body.secretKey }),
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return after;
  }

  /**
   * «Probar TPV»: comprueba el comercio, el terminal y la clave con Redsys sin
   * cobrar nada. Usa lo escrito en el formulario (sin guardarlo) y, lo que no
   * venga, lo guardado.
   */
  @RequirePermission('billing:configure')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async test(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TestRedsysSettingsBody,
  ): Promise<RedsysTestResultDto> {
    const saved = await this.settings.getResolved(user.tenantId);
    const stored = await this.settings.get(user.tenantId);
    const secretKey = body.secretKey || saved?.secretKey;
    if (!secretKey) {
      throw new BadRequestException({
        code: 'redsys_secret_required',
        message: 'Escribe la clave secreta del TPV para poder probarlo.',
      });
    }
    return this.charge.testCredentials({
      merchantCode: body.merchantCode || stored.merchantCode,
      terminal: body.terminal || stored.terminal,
      environment: body.environment ?? stored.environment,
      secretKey,
    });
  }

  @RequirePermission('payments:charge')
  @Post('invoices/:id/redirect')
  @HttpCode(HttpStatus.OK)
  redirect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RedsysRedirectBody,
  ): Promise<RedsysRedirectDto> {
    return this.redsys.createRedirect(user.tenantId, id, {
      ...(body.payMethod ? { payMethod: body.payMethod } : {}),
    });
  }
}
