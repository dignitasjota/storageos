import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { InvitationTokensService } from './invitation-tokens.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationTokensService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
