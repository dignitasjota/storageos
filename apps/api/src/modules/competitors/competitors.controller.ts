import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateCompetitorFacilitySchema,
  CreateCompetitorUnitSchema,
  UpdateCompetitorFacilitySchema,
  UpdateCompetitorUnitSchema,
  type CompetitorFacilityDto,
  type CompetitorUnitDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CompetitorsService } from './competitors.service';

class CreateCompetitorFacilityDto extends createZodDto(CreateCompetitorFacilitySchema) {}
class UpdateCompetitorFacilityDto extends createZodDto(UpdateCompetitorFacilitySchema) {}
class CreateCompetitorUnitDto extends createZodDto(CreateCompetitorUnitSchema) {}
class UpdateCompetitorUnitDto extends createZodDto(UpdateCompetitorUnitSchema) {}

/**
 * Fichar la competencia (locales + trasteros con m² y precio) para anclar la
 * sugerencia de precio. Lectura con `analytics:read`; gestión con `units:manage`.
 */
@Controller('competitors')
export class CompetitorsController {
  constructor(private readonly service: CompetitorsService) {}

  @RequirePermission('analytics:read')
  @Get()
  listFacilities(@CurrentUser() user: AuthenticatedUser): Promise<CompetitorFacilityDto[]> {
    return this.service.listFacilities(user.tenantId);
  }

  @RequirePermission('units:manage')
  @Post()
  createFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCompetitorFacilityDto,
  ): Promise<CompetitorFacilityDto> {
    return this.service.createFacility(user.tenantId, body);
  }

  @RequirePermission('units:manage')
  @Patch(':id')
  updateFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCompetitorFacilityDto,
  ): Promise<CompetitorFacilityDto> {
    return this.service.updateFacility(user.tenantId, id, body);
  }

  @RequirePermission('units:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.removeFacility(user.tenantId, id);
  }

  // --- trasteros de un competidor ---

  @RequirePermission('analytics:read')
  @Get(':id/units')
  listUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CompetitorUnitDto[]> {
    return this.service.listUnits(user.tenantId, id);
  }

  @RequirePermission('units:manage')
  @Post(':id/units')
  createUnit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateCompetitorUnitDto,
  ): Promise<CompetitorUnitDto> {
    return this.service.createUnit(user.tenantId, id, body);
  }

  @RequirePermission('units:manage')
  @Patch('units/:unitId')
  updateUnit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Body() body: UpdateCompetitorUnitDto,
  ): Promise<CompetitorUnitDto> {
    return this.service.updateUnit(user.tenantId, unitId, body);
  }

  @RequirePermission('units:manage')
  @Delete('units/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeUnit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
  ): Promise<void> {
    await this.service.removeUnit(user.tenantId, unitId);
  }
}
