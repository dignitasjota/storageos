import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';

import {
  PlatformAdminController,
  PlatformBannerPublicController,
  PlatformLegalPublicController,
} from './platform.controller';
import { PlatformService } from './platform.service';

/** Banner global + notificaciones del super admin + documentos legales. */
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    PlatformAdminController,
    PlatformBannerPublicController,
    PlatformLegalPublicController,
  ],
  providers: [PlatformService, AdminGuard],
  exports: [PlatformService],
})
export class PlatformModule {}
