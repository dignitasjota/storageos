import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { LandingModule } from '../landing/landing.module';

import { AreaPagesController } from './area-pages.controller';
import { AreaPagesService } from './area-pages.service';

@Module({
  imports: [AiModule, LandingModule],
  controllers: [AreaPagesController],
  providers: [AreaPagesService],
  exports: [AreaPagesService],
})
export class AreaPagesModule {}
