import {
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

import { RedsysSettingsService } from './redsys-settings.service';
import { RedsysService } from './redsys.service';

import type { Request } from 'express';

class UpdateRedsysSettingsBody extends createZodDto(UpdateRedsysSettingsSchema) {}
class RedsysRedirectBody extends createZodDto(RedsysRedirectRequestSchema) {}

@Controller('settings/redsys')
export class RedsysController {
  constructor(
    private readonly settings: RedsysSettingsService,
    private readonly redsys: RedsysService,
    private readonly audit: AuditService,
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
