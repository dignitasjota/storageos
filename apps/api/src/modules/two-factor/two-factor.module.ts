import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { RecoveryCodesService } from './recovery-codes.service';
import { TotpService } from './totp.service';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';

@Module({
  imports: [AuthModule],
  controllers: [TwoFactorController],
  providers: [TotpService, RecoveryCodesService, TwoFactorService],
  exports: [TwoFactorService, TotpService],
})
export class TwoFactorModule {}
