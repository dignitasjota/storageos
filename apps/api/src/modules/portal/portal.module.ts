import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  imports: [AuthModule, JwtModule.register({})],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
