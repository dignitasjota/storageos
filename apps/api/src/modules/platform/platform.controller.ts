import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import {
  UpdatePlatformBannerSchema,
  type PlatformBannerDto,
  type SuperAdminNotificationDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';

import { PlatformService } from './platform.service';

class UpdateBannerDto extends createZodDto(UpdatePlatformBannerSchema) {}

/** Banner global visible por los tenants (endpoint público autenticado por tenant). */
@Controller('platform-banner')
export class PlatformBannerPublicController {
  constructor(private readonly service: PlatformService) {}

  @Get()
  get(): Promise<PlatformBannerDto | null> {
    return this.service.getPublicBanner();
  }
}

/** Gestión del banner + feed de notificaciones. Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform')
export class PlatformAdminController {
  constructor(private readonly service: PlatformService) {}

  @Get('banner')
  getBanner(): Promise<PlatformBannerDto> {
    return this.service.getBanner();
  }

  @Put('banner')
  updateBanner(@Body() body: UpdateBannerDto): Promise<PlatformBannerDto> {
    return this.service.updateBanner(body);
  }

  @Get('notifications')
  listNotifications(): Promise<SuperAdminNotificationDto[]> {
    return this.service.listNotifications();
  }

  @Get('notifications/unread-count')
  unreadCount(): Promise<{ count: number }> {
    return this.service.unreadCount();
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(): Promise<void> {
    await this.service.markAllRead();
  }
}
