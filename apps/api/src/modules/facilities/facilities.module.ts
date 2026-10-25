import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { FacilitiesController } from './facilities.controller';
import { FacilitiesService } from './facilities.service';
import { FacilityDocumentsService } from './facility-documents.service';
import { FacilityFloorsController } from './facility-floors.controller';
import { FacilityFloorsService } from './facility-floors.service';
import { FacilityInsightsService } from './facility-insights.service';
import { UnitTypesController } from './unit-types.controller';
import { UnitTypesService } from './unit-types.service';
import { UnitsInventoryService } from './units-inventory.service';
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
    UnitsInventoryService,
    FacilityInsightsService,
    FacilityDocumentsService,
  ],
  exports: [UnitsService],
})
export class FacilitiesModule {}
