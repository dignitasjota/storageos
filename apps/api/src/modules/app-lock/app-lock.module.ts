import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AppLockController } from './app-lock.controller';
import { AppLockService } from './app-lock.service';

@Module({
  imports: [AuthModule],
  controllers: [AppLockController],
  providers: [AppLockService],
})
export class AppLockModule {}
