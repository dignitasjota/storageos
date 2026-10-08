import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { EmailModule } from '../email/email.module';
import { PlatformModule } from '../platform/platform.module';

import {
  PlatformContactAdminController,
  PlatformContactPublicController,
} from './platform-contact.controller';
import { PlatformContactService } from './platform-contact.service';

/** Formulario de contacto de la web de TrasterOS. */
@Module({
  imports: [JwtModule.register({}), EmailModule, PlatformModule],
  controllers: [PlatformContactPublicController, PlatformContactAdminController],
  providers: [PlatformContactService, AdminGuard],
})
export class PlatformContactModule {}
