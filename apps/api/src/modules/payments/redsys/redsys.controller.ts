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
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { RedsysSettingsService } from './redsys-settings.service';
import { RedsysService } from './redsys.service';

class UpdateRedsysSettingsBody extends createZodDto(UpdateRedsysSettingsSchema) {}
class RedsysRedirectBody extends createZodDto(RedsysRedirectRequestSchema) {}

@Controller('settings/redsys')
export class RedsysController {
  constructor(
    private readonly settings: RedsysSettingsService,
    private readonly redsys: RedsysService,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<RedsysSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateRedsysSettingsBody,
  ): Promise<RedsysSettingsDto> {
    return this.settings.update(user.tenantId, body);
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
