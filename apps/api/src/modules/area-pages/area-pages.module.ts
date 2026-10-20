import { Module } from '@nestjs/common';

import { AreaPagesController } from './area-pages.controller';
import { AreaPagesService } from './area-pages.service';

@Module({
  controllers: [AreaPagesController],
  providers: [AreaPagesService],
})
export class AreaPagesModule {}
