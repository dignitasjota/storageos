import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';

import {
  PlatformBlogAdminController,
  PlatformBlogPublicController,
} from './platform-blog.controller';
import { PlatformBlogService } from './platform-blog.service';

/** Blog de la web de TrasterOS (trasteros.pro/blog). */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformBlogPublicController, PlatformBlogAdminController],
  providers: [PlatformBlogService, AdminGuard],
})
export class PlatformBlogModule {}
