import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContractsModule } from '../contracts/contracts.module';

import { RgpdController } from './rgpd.controller';
import { RgpdService } from './rgpd.service';

@Module({
  imports: [AuthModule, ContractsModule],
  controllers: [RgpdController],
  providers: [RgpdService],
})
export class RgpdModule {}
