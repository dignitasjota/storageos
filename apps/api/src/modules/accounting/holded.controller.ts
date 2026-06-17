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
  type HoldedSettingsDto,
  type HoldedTestResultDto,
  UpdateHoldedSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { HoldedSettingsService } from './holded-settings.service';
import { HoldedSyncService } from './holded-sync.service';

class UpdateHoldedSettingsBody extends createZodDto(UpdateHoldedSettingsSchema) {}

@Controller('settings/holded')
export class HoldedController {
  constructor(
    private readonly settings: HoldedSettingsService,
    private readonly sync: HoldedSyncService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<HoldedSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @Roles('owner')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateHoldedSettingsBody,
  ): Promise<HoldedSettingsDto> {
    return this.settings.update(user.tenantId, body);
  }

  @Roles('owner', 'manager')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthenticatedUser): Promise<HoldedTestResultDto> {
    return this.settings.test(user.tenantId);
  }

  @Roles('owner', 'manager')
  @Post('backfill')
  backfill(@CurrentUser() user: AuthenticatedUser): Promise<{ synced: number }> {
    return this.sync.backfill(user.tenantId);
  }

  @Roles('owner', 'manager')
  @Post('invoices/:id/sync')
  @HttpCode(HttpStatus.OK)
  async syncInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.sync.pushInvoice(user.tenantId, id, true);
    return { ok: true };
  }
}
