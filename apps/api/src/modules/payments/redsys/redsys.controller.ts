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
  type RedsysSettingsDto,
  UpdateRedsysSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';

import { RedsysSettingsService } from './redsys-settings.service';
import { RedsysService } from './redsys.service';

class UpdateRedsysSettingsBody extends createZodDto(UpdateRedsysSettingsSchema) {}

@Controller('settings/redsys')
export class RedsysController {
  constructor(
    private readonly settings: RedsysSettingsService,
    private readonly redsys: RedsysService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<RedsysSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @Roles('owner')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateRedsysSettingsBody,
  ): Promise<RedsysSettingsDto> {
    return this.settings.update(user.tenantId, body);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('invoices/:id/redirect')
  @HttpCode(HttpStatus.OK)
  redirect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RedsysRedirectDto> {
    return this.redsys.createRedirect(user.tenantId, id);
  }
}
