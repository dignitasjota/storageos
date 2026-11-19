import {
  BadRequestException,
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
  Query,
} from '@nestjs/common';
import {
  CreateCompetitorFacilitySchema,
  CreateCompetitorUnitSchema,
  UpdateCompetitorFacilitySchema,
  UpdateCompetitorUnitSchema,
  ReviewCompetitorSchema,
  BulkCreateCompetitorUnitsSchema,
  CompetitorAiParseSchema,
  type CompetitorAiParseResultDto,
  type CompetitorPromotionDto,
  type CompetitorTrendDto,
  type CompetitorUnitExportRowDto,
  type MarketPriceMapDto,
  type CompetitorFacilityDto,
  type CompetitorUnitDto,
  type CompetitorUnitObservationDto,
  type MarketOccupancyDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CompetitorsMarketService } from './competitors-market.service';
import { CompetitorsService, type CompetitorActor } from './competitors.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facilityParam(facilityId?: string): string | null {
  if (!facilityId) return null;
  if (!UUID_RE.test(facilityId)) {
    throw new BadRequestException({
      code: 'invalid_facility_id',
      message: 'El local indicado no es válido',
    });
  }
  return facilityId;
}

function actorOf(user: AuthenticatedUser): CompetitorActor {
  return { userId: user.sub, facilityScope: user.facilityScope ?? null };
}

class CreateCompetitorFacilityDto extends createZodDto(CreateCompetitorFacilitySchema) {}
class UpdateCompetitorFacilityDto extends createZodDto(UpdateCompetitorFacilitySchema) {}
class CreateCompetitorUnitDto extends createZodDto(CreateCompetitorUnitSchema) {}
class UpdateCompetitorUnitDto extends createZodDto(UpdateCompetitorUnitSchema) {}
class ReviewCompetitorDto extends createZodDto(ReviewCompetitorSchema) {}
class BulkCreateCompetitorUnitsDto extends createZodDto(BulkCreateCompetitorUnitsSchema) {}
class CompetitorAiParseDto extends createZodDto(CompetitorAiParseSchema) {}

/**
 * Fichar la competencia (locales + trasteros con m² y precio) para anclar la
 * sugerencia de precio. Lectura con `analytics:read`; gestión con `units:manage`.
 */
@Controller('competitors')
export class CompetitorsController {
  constructor(
    private readonly service: CompetitorsService,
    private readonly market: CompetitorsMarketService,
  ) {}

  /** Tu precio frente al del mercado por tipo de trastero. Antes de `:id`. */
  @RequirePermission('analytics:read')
  @Get('price-map')
  priceMap(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<MarketPriceMapDto> {
    return this.market.priceMap(
      user.tenantId,
      user.facilityScope ?? null,
      facilityParam(facilityId),
    );
  }

  /** Todos los trasteros de la competencia para exportar. Antes de `:id`. */
  @RequirePermission('analytics:read')
  @Get('export')
  exportUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CompetitorUnitExportRowDto[]> {
    return this.market.exportUnits(
      user.tenantId,
      user.facilityScope ?? null,
      facilityParam(facilityId),
    );
  }

  /** Evolución mensual de su precio comparable y su ocupación. */
  @RequirePermission('analytics:read')
  @Get(':id/trend')
  trend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('months') months?: string,
  ): Promise<CompetitorTrendDto> {
    const n = Math.min(24, Math.max(3, Number(months) || 12));
    return this.market.trend(user.tenantId, id, user.facilityScope ?? null, n);
  }

  /** Histórico de sus promociones. */
  @RequirePermission('analytics:read')
  @Get(':id/promotions')
  promotions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CompetitorPromotionDto[]> {
    return this.service.listPromotions(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Varios trasteros de una vez (pegados de una tabla o un CSV). */
  @RequirePermission('units:manage')
  @Post(':id/units/bulk')
  bulkUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: BulkCreateCompetitorUnitsDto,
  ): Promise<CompetitorUnitDto[]> {
    return this.service.bulkCreateUnits(user.tenantId, id, body, actorOf(user));
  }

  /** La IA lee su página de tarifas y propone sus trasteros (no guarda nada). */
  @RequirePermission('units:manage')
  @Post(':id/ai-parse')
  @HttpCode(HttpStatus.OK)
  aiParse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CompetitorAiParseDto,
  ): Promise<CompetitorAiParseResultDto> {
    return this.market.aiParse(user.tenantId, user.sub, id, body.text, user.facilityScope ?? null);
  }

  @RequirePermission('analytics:read')
  @Get()
  listFacilities(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CompetitorFacilityDto[]> {
    return this.service.listFacilities(
      user.tenantId,
      user.facilityScope ?? null,
      facilityParam(facilityId),
    );
  }

  /** Ocupación de mercado (mi ocupación vs la de la competencia). Antes de `:id`. */
  @RequirePermission('analytics:read')
  @Get('occupancy')
  marketOccupancy(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<MarketOccupancyDto> {
    return this.service.getMarketOccupancy(
      user.tenantId,
      user.facilityScope ?? null,
      facilityParam(facilityId),
    );
  }

  @RequirePermission('units:manage')
  @Post()
  createFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCompetitorFacilityDto,
  ): Promise<CompetitorFacilityDto> {
    return this.service.createFacility(user.tenantId, body, actorOf(user));
  }

  @RequirePermission('units:manage')
  @Patch(':id')
  updateFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCompetitorFacilityDto,
  ): Promise<CompetitorFacilityDto> {
    return this.service.updateFacility(user.tenantId, id, body, actorOf(user));
  }

  @RequirePermission('units:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.removeFacility(user.tenantId, id, actorOf(user));
  }

  // --- trasteros de un competidor ---

  @RequirePermission('analytics:read')
  @Get(':id/units')
  listUnits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CompetitorUnitDto[]> {
    return this.service.listUnits(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('units:manage')
  @Post(':id/units')
  createUnit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateCompetitorUnitDto,
  ): Promise<CompetitorUnitDto> {
    return this.service.createUnit(user.tenantId, id, body, actorOf(user));
  }

  @RequirePermission('units:manage')
  @Patch('units/:unitId')
  updateUnit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
    @Body() body: UpdateCompetitorUnitDto,
  ): Promise<CompetitorUnitDto> {
    return this.service.updateUnit(user.tenantId, unitId, body, actorOf(user));
  }

  @RequirePermission('units:manage')
  @Delete('units/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeUnit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
  ): Promise<void> {
    await this.service.removeUnit(user.tenantId, unitId, actorOf(user));
  }

  /** Revisión: precio y estado de hoy de cada trastero (todos quedan comprobados hoy). */
  @RequirePermission('units:manage')
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReviewCompetitorDto,
  ): Promise<CompetitorUnitDto[]> {
    return this.service.review(user.tenantId, id, body, actorOf(user));
  }

  /** Histórico de comprobaciones de un trastero de la competencia. */
  @RequirePermission('analytics:read')
  @Get('units/:unitId/history')
  unitHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
  ): Promise<CompetitorUnitObservationDto[]> {
    return this.service.unitHistory(user.tenantId, unitId, user.facilityScope ?? null);
  }
}
