import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';

import { OwnerAeatCredentialController } from './owner-aeat-credential.controller';
import { OwnerStatementsController } from './owner-statements.controller';
import { OwnerStatementsService } from './owner-statements.service';
import { OwnersController } from './owners.controller';
import { OwnersService } from './owners.service';

@Module({
  imports: [AuthModule, BillingModule, EmailModule],
  controllers: [OwnersController, OwnerAeatCredentialController, OwnerStatementsController],
  providers: [OwnersService, OwnerStatementsService],
  exports: [OwnersService],
})
export class OwnersModule {}
