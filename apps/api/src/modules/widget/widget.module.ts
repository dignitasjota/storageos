import { Module } from '@nestjs/common';

import { LeadsModule } from '../leads/leads.module';

import { WidgetController } from './widget.controller';
import { WidgetService } from './widget.service';

@Module({
  imports: [LeadsModule],
  controllers: [WidgetController],
  providers: [WidgetService],
})
export class WidgetModule {}
