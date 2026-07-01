import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';

import { PlatformAdminController, PlatformBannerPublicController } from './platform.controller';
import { PlatformService } from './platform.service';

/** Banner global + notificaciones del super admin (feed de eventos de plataforma). */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformAdminController, PlatformBannerPublicController],
  providers: [PlatformService, AdminGuard],
  exports: [PlatformService],
})
export class PlatformModule {}
