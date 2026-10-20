import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  CreateAreaPageSchema,
  UpdateAreaPageSchema,
  type AreaPagesSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AreaPagesService } from './area-pages.service';

class CreateAreaPageDto extends createZodDto(CreateAreaPageSchema) {}
class UpdateAreaPageDto extends createZodDto(UpdateAreaPageSchema) {}

/** Páginas de zona de la web del tenant (`/trasteros-en-<zona>`). Feature `web_premium`. */
@RequireFeature('web_premium')
@Controller('settings/web/area-pages')
export class AreaPagesController {
  constructor(private readonly pages: AreaPagesService) {}

  @RequirePermission('settings:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<AreaPagesSettingsDto> {
    return this.pages.settings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAreaPageDto,
  ): Promise<AreaPagesSettingsDto> {
    return this.pages.create(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAreaPageDto,
  ): Promise<AreaPagesSettingsDto> {
    return this.pages.update(user.tenantId, id, body);
  }

  @RequirePermission('settings:manage')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AreaPagesSettingsDto> {
    return this.pages.remove(user.tenantId, id);
  }
}
