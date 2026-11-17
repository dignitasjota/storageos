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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AssignSalesAccountSchema,
  CreateSalesCommissionItemSchema,
  CreateSalesRepSchema,
  CreateSalesSettlementSchema,
  DecideSalesSchema,
  ReassignSalesPortfolioSchema,
  SalesMaterialUploadSchema,
  UpdatePlatformSalesSettingsSchema,
  UpdateSalesCommissionPlanSchema,
  UpdateSalesRepSchema,
  UpsertSalesCadenceSchema,
  UpsertSalesCommissionConceptSchema,
  UpsertSalesMaterialSchema,
  UpsertSalesTargetSchema,
  UpsertSalesTemplateSchema,
  type ImpersonationTokenDto,
  type PlatformSalesSettingsDto,
  type SalesAccountRepDto,
  type SalesAddonClaimDto,
  type SalesCadenceDto,
  type SalesCommissionItemDto,
  type SalesCommissionPlanDto,
  type SalesMaterialDto,
  type SalesPendingAssignmentDto,
  type SalesRepAccountsDto,
  type SalesRepDetailDto,
  type SalesSettlementDto,
  type SalesTargetDto,
  type SalesTeamDto,
  type SalesTemplateDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminGuard } from '../admin.guard';
import { CurrentSuperAdmin } from '../current-super-admin.decorator';
import { RequireSuperadmin } from '../require-superadmin.decorator';

import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import { SalesContentService } from './sales-content.service';
import { SalesDemoService } from './sales-demo.service';
import { SalesTeamService } from './sales-team.service';

import type { Request } from 'express';

class CreateRepDto extends createZodDto(CreateSalesRepSchema) {}
class UpdateRepDto extends createZodDto(UpdateSalesRepSchema) {}
class PlanDto extends createZodDto(UpdateSalesCommissionPlanSchema) {}
class ConceptDto extends createZodDto(UpsertSalesCommissionConceptSchema) {}
class TargetDto extends createZodDto(UpsertSalesTargetSchema) {}
class AssignDto extends createZodDto(AssignSalesAccountSchema) {}
class ReassignDto extends createZodDto(ReassignSalesPortfolioSchema) {}
class DecideDto extends createZodDto(DecideSalesSchema) {}
class ItemDto extends createZodDto(CreateSalesCommissionItemSchema) {}
class SettlementDto extends createZodDto(CreateSalesSettlementSchema) {}
class SettingsDto extends createZodDto(UpdatePlatformSalesSettingsSchema) {}
class MaterialDto extends createZodDto(UpsertSalesMaterialSchema) {}
class MaterialUploadDto extends createZodDto(SalesMaterialUploadSchema) {}
class TemplateDto extends createZodDto(UpsertSalesTemplateSchema) {}
class CadenceDto extends createZodDto(UpsertSalesCadenceSchema) {}

const MONTH_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Dirección comercial (`/admin/sales-team/*`): solo el rol superadmin. El
 * equipo, sus comisiones, lo que espera aprobación, reasignar cuentas, la
 * cuenta de demostración y los materiales.
 */
@Public()
@RequireSuperadmin()
@UseGuards(AdminGuard)
@Controller('admin/sales-team')
export class SalesTeamController {
  constructor(
    private readonly team: SalesTeamService,
    private readonly assignment: SalesAssignmentService,
    private readonly commissions: SalesCommissionsService,
    private readonly content: SalesContentService,
    private readonly demo: SalesDemoService,
  ) {}

  @Get()
  overview(): Promise<SalesTeamDto> {
    return this.team.overview();
  }

  @Get('pending-count')
  pendingCount(): Promise<{ count: number }> {
    return this.team.pendingCount();
  }

  @Get('pending-assignments')
  pendingAssignments(): Promise<SalesPendingAssignmentDto[]> {
    return this.team.pendingAssignments();
  }

  // -------------------------------------------------------------- comerciales

  @Post('reps')
  createRep(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: CreateRepDto,
  ): Promise<SalesRepDetailDto> {
    return this.team.createRep(body, byId);
  }

  @Get('reps/:id')
  rep(@Param('id', new ParseUUIDPipe()) id: string): Promise<SalesRepDetailDto> {
    return this.team.repDetail(id);
  }

  @Patch('reps/:id')
  updateRep(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRepDto,
  ): Promise<SalesRepDetailDto> {
    return this.team.updateRep(id, body, byId);
  }

  @Get('reps/:id/accounts')
  repAccounts(@Param('id', new ParseUUIDPipe()) id: string): Promise<SalesRepAccountsDto> {
    return this.team.repAccounts(id);
  }

  @Post('reps/:id/reassign')
  @HttpCode(HttpStatus.OK)
  reassign(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReassignDto,
  ): Promise<{ moved: number }> {
    return this.team.reassignPortfolio(id, body, byId);
  }

  @Put('reps/:id/plan')
  plan(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PlanDto,
  ): Promise<SalesCommissionPlanDto> {
    return this.commissions.updatePlan(id, body, byId);
  }

  @Post('reps/:id/concepts')
  createConcept(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ConceptDto,
  ): Promise<SalesCommissionPlanDto> {
    return this.commissions.upsertConcept(id, null, body, byId);
  }

  @Patch('reps/:id/concepts/:conceptId')
  updateConcept(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('conceptId', new ParseUUIDPipe()) conceptId: string,
    @Body() body: ConceptDto,
  ): Promise<SalesCommissionPlanDto> {
    return this.commissions.upsertConcept(id, conceptId, body, byId);
  }

  @Delete('reps/:id/concepts/:conceptId')
  deleteConcept(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('conceptId', new ParseUUIDPipe()) conceptId: string,
  ): Promise<SalesCommissionPlanDto> {
    return this.commissions.deleteConcept(id, conceptId, byId);
  }

  @Put('reps/:id/targets')
  target(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TargetDto,
  ): Promise<SalesTargetDto[]> {
    return this.commissions.upsertTarget(id, body, byId);
  }

  // ----------------------------------------------------------------- cuentas

  @Post('assign')
  @HttpCode(HttpStatus.OK)
  assign(@CurrentSuperAdmin('sub') byId: string, @Body() body: AssignDto): Promise<{ ok: true }> {
    return this.team.assign(body, byId);
  }

  @Get('accounts')
  accountRep(
    @Query('tenantId') tenantId?: string,
    @Query('leadId') leadId?: string,
  ): Promise<SalesAccountRepDto> {
    if (tenantId && UUID_RE.test(tenantId)) return this.assignment.accountRep({ tenantId });
    if (leadId && UUID_RE.test(leadId)) return this.assignment.accountRep({ leadId });
    throw new BadRequestException({ code: 'account_required', message: 'Indica la cuenta' });
  }

  // ------------------------------------------------------------- comisiones

  @Get('claims')
  async claims(@Query('status') status?: string): Promise<SalesAddonClaimDto[]> {
    await this.commissions.syncClaims();
    return this.commissions.claims({
      ...(status && ['pending', 'approved', 'rejected'].includes(status) ? { status } : {}),
    });
  }

  @Post('claims/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveClaim(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DecideDto,
  ): Promise<SalesAddonClaimDto> {
    return this.commissions.decideClaim(id, true, body.note, byId);
  }

  @Post('claims/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectClaim(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DecideDto,
  ): Promise<SalesAddonClaimDto> {
    return this.commissions.decideClaim(id, false, body.note, byId);
  }

  @Get('commissions')
  items(
    @Query('repId') repId?: string,
    @Query('month') month?: string,
    @Query('status') status?: string,
  ): Promise<SalesCommissionItemDto[]> {
    return this.commissions.items({
      ...(repId && UUID_RE.test(repId) ? { repId } : {}),
      ...(month && MONTH_RE.test(month) ? { month } : {}),
      ...(status && ['pending', 'approved', 'rejected'].includes(status) ? { status } : {}),
    });
  }

  @Post('commissions/items')
  createItem(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: ItemDto,
  ): Promise<SalesCommissionItemDto> {
    return this.commissions.createItem(body, byId);
  }

  @Post('commissions/items/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveItem(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DecideDto,
  ): Promise<SalesCommissionItemDto> {
    return this.commissions.decideItem(id, true, body.note, byId);
  }

  @Post('commissions/items/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectItem(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DecideDto,
  ): Promise<SalesCommissionItemDto> {
    return this.commissions.decideItem(id, false, body.note, byId);
  }

  /** Recalcula ya (lo hace solo cada hora). */
  @Post('commissions/recalculate')
  @HttpCode(HttpStatus.OK)
  async recalculate(): Promise<{ claims: number; created: number }> {
    const claims = await this.commissions.syncClaims();
    const { created } = await this.commissions.computeAll();
    return { claims, created };
  }

  @Get('settlements')
  settlements(@Query('repId') repId?: string): Promise<SalesSettlementDto[]> {
    return this.commissions.settlements(repId && UUID_RE.test(repId) ? repId : undefined);
  }

  @Post('settlements')
  createSettlement(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: SettlementDto,
  ): Promise<SalesSettlementDto> {
    return this.commissions.createSettlement(body, byId);
  }

  @Post('settlements/:id/paid')
  @HttpCode(HttpStatus.OK)
  settlementPaid(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SalesSettlementDto> {
    return this.commissions.markSettlementPaid(id, byId);
  }

  // ----------------------------------------------------------------- ajustes

  @Get('settings')
  settings(): Promise<PlatformSalesSettingsDto> {
    return this.assignment.settingsDto();
  }

  @Put('settings')
  updateSettings(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: SettingsDto,
  ): Promise<PlatformSalesSettingsDto> {
    return this.assignment.updateSettings(body, byId);
  }

  @Post('demo')
  createDemo(@CurrentSuperAdmin('sub') byId: string): Promise<PlatformSalesSettingsDto> {
    return this.demo.create(byId);
  }

  @Post('demo/reset')
  @HttpCode(HttpStatus.OK)
  resetDemo(@CurrentSuperAdmin('sub') byId: string): Promise<PlatformSalesSettingsDto> {
    return this.demo.resetNow(byId);
  }

  @Post('demo/open')
  @HttpCode(HttpStatus.OK)
  openDemo(
    @CurrentSuperAdmin('sub') byId: string,
    @Req() req: Request,
  ): Promise<ImpersonationTokenDto> {
    return this.demo.open(byId, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  // ------------------------------------------------------------ materiales

  @Get('materials')
  materials(): Promise<SalesMaterialDto[]> {
    return this.content.materials();
  }

  @Post('materials/upload-url')
  materialUploadUrl(
    @Body() body: MaterialUploadDto,
  ): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    return this.content.materialUploadUrl(body);
  }

  @Post('materials')
  createMaterial(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: MaterialDto,
  ): Promise<SalesMaterialDto> {
    return this.content.saveMaterial(null, body, byId);
  }

  @Patch('materials/:id')
  updateMaterial(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MaterialDto,
  ): Promise<SalesMaterialDto> {
    return this.content.saveMaterial(id, body, byId);
  }

  @Delete('materials/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMaterial(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.content.deleteMaterial(id, byId);
  }

  @Get('materials/:id/download')
  materialDownload(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ url: string }> {
    return this.content.materialDownloadUrl(id);
  }

  // ------------------------------------------------------------ plantillas

  @Get('templates')
  templates(): Promise<SalesTemplateDto[]> {
    return this.content.templates(false);
  }

  @Post('templates')
  createTemplate(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: TemplateDto,
  ): Promise<SalesTemplateDto> {
    return this.content.saveTemplate(null, body, byId);
  }

  @Patch('templates/:id')
  updateTemplate(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TemplateDto,
  ): Promise<SalesTemplateDto> {
    return this.content.saveTemplate(id, body, byId);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTemplate(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.content.deleteTemplate(id, byId);
  }

  // ------------------------------------------------------------- cadencias

  @Get('cadences')
  cadences(): Promise<SalesCadenceDto[]> {
    return this.content.cadences(false);
  }

  @Post('cadences')
  createCadence(
    @CurrentSuperAdmin('sub') byId: string,
    @Body() body: CadenceDto,
  ): Promise<SalesCadenceDto> {
    return this.content.saveCadence(null, body, byId);
  }

  @Patch('cadences/:id')
  updateCadence(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CadenceDto,
  ): Promise<SalesCadenceDto> {
    return this.content.saveCadence(id, body, byId);
  }

  @Delete('cadences/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCadence(
    @CurrentSuperAdmin('sub') byId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.content.deleteCadence(id, byId);
  }
}
