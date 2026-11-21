import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { LandingModule } from '../landing/landing.module';

import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';

@Module({
  imports: [AuthModule, AiModule, LandingModule],
  controllers: [BlogController],
  providers: [BlogService],
  exports: [BlogService],
})
export class BlogModule {}
