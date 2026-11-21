import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';

import { AdminHelpTopicsController, HelpTopicsController } from './help-topics.controller';
import { HelpTopicsService } from './help-topics.service';

/** Guías de «Cómo funciona» (del código + las editadas en el panel admin). */
@Module({
  imports: [JwtModule.register({})],
  controllers: [HelpTopicsController, AdminHelpTopicsController],
  providers: [HelpTopicsService, AdminGuard, SuperAdminAuditService],
})
export class HelpTopicsModule {}
