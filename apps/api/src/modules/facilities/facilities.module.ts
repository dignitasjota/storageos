import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { FacilitiesController } from './facilities.controller';
import { FacilitiesService } from './facilities.service';
import { FacilityFloorsController } from './facility-floors.controller';
import { FacilityFloorsService } from './facility-floors.service';
import { UnitTypesController } from './unit-types.controller';
import { UnitTypesService } from './unit-types.service';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';

@Module({
  imports: [AuthModule],
  controllers: [
    FacilitiesController,
    UnitTypesController,
    UnitsController,
    FacilityFloorsController,
    DashboardController,
  ],
  providers: [
    FacilitiesService,
    UnitTypesService,
    UnitsService,
    FacilityFloorsService,
    DashboardService,
  ],
})
export class FacilitiesModule {}
