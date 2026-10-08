import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';

import { OwnerAeatCredentialController } from './owner-aeat-credential.controller';
import { OwnersController } from './owners.controller';
import { OwnersService } from './owners.service';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [OwnersController, OwnerAeatCredentialController],
  providers: [OwnersService],
  exports: [OwnersService],
})
export class OwnersModule {}
