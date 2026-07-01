import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { CompetitorsController } from './competitors.controller';
import { CompetitorsService } from './competitors.service';

/** Fichar la competencia (locales + trasteros) para el pricing por competencia. */
@Module({
  imports: [AuthModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService],
  exports: [CompetitorsService],
})
export class CompetitorsModule {}
