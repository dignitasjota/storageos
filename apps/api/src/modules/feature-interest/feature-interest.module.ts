import { Module } from '@nestjs/common';

import { FeatureInterestController } from './feature-interest.controller';
import { FeatureInterestService } from './feature-interest.service';

@Module({
  controllers: [FeatureInterestController],
  providers: [FeatureInterestService],
})
export class FeatureInterestModule {}
