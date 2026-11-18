import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  AcknowledgeSalesSettlementSchema,
  CreatePlatformLeadActivitySchema,
  CreatePlatformLeadFollowupSchema,
  CreateSalesProspectSchema,
  EnrollSalesCadenceSchema,
  LosePlatformLeadSchema,
  MovePlatformLeadSchema,
  RequestSalesConceptSchema,
  SalesAddonOfferSchema,
  SalesApprovalRequestSchema,
  SalesCallOutcomeSchema,
  SalesClaimNoteSchema,
  SalesCreateTenantSchema,
  SalesExtendTrialSchema,
  SalesImportSchema,
  SalesSimulateQuoteSchema,
  SendAdminQuoteSchema,
  SendPlatformLeadEmailSchema,
  UpdatePlatformLeadFollowupSchema,
  UpdateSalesLeadSchema,
  UpdateSalesMeSchema,
  UpdateSalesProfileSchema,
  type AdminAddonOpportunityDto,
  type AdminApprovalRequestDto,
  type AdminQuoteDto,
  type ImpersonationTokenDto,
  type PlatformLeadFollowupDto,
  type SalesAccountDto,
  type SalesAccountSummaryDto,
  type SalesAddonClaimDto,
  type SalesCadenceDto,
  type SalesClientRowDto,
  type SalesCommissionsDto,
  type SalesDemoStatusDto,
  type SalesForecastDto,
  type SalesImportResultDto,
  type SalesLeadListDto,
  type SalesMaterialDto,
  type SalesOfferDto,
  type SalesRepProfileDto,
  type SalesSettlementDto,
  type SalesTargetDto,
  type SalesTemplateDto,
  type SalesTodayDto,
  type SuperAdminNotificationDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminGuard } from '../admin.guard';
import { CurrentSuperAdmin, type AuthenticatedSuperAdmin } from '../current-super-admin.decorator';
import { SalesAccess } from '../require-superadmin.decorator';

import { SalesAccountsService } from './sales-accounts.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import { SalesContentService } from './sales-content.service';
import { SalesDemoService } from './sales-demo.service';
import { SalesInsightsService } from './sales-insights.service';
import { SalesNotifyService } from './sales-notify.service';
import { SalesSellingService, type SalesCatalogDto } from './sales-selling.service';

import type { SalesActor } from './sales-common';
import type { Request, Response } from 'express';

class CreateProspectDto extends createZodDto(CreateSalesProspectSchema) {}
class UpdateLeadDto extends createZodDto(UpdateSalesLeadSchema) {}
class ProfileDto extends createZodDto(UpdateSalesProfileSchema) {}
class MoveDto extends createZodDto(MovePlatformLeadSchema) {}
class LoseDto extends createZodDto(LosePlatformLeadSchema) {}
class ActivityDto extends createZodDto(CreatePlatformLeadActivitySchema) {}
class OutcomeDto extends createZodDto(SalesCallOutcomeSchema) {}
class FollowupDto extends createZodDto(CreatePlatformLeadFollowupSchema) {}
class UpdateFollowupDto extends createZodDto(UpdatePlatformLeadFollowupSchema) {}
class EmailDto extends createZodDto(SendPlatformLeadEmailSchema) {}
class CreateTenantDto extends createZodDto(SalesCreateTenantSchema) {}
class QuoteDto extends createZodDto(SendAdminQuoteSchema) {}
class SimulateDto extends createZodDto(SalesSimulateQuoteSchema) {}
class CadenceDto extends createZodDto(EnrollSalesCadenceSchema) {}
class AddonOfferDto extends createZodDto(SalesAddonOfferSchema) {}
class ExtendTrialDto extends createZodDto(SalesExtendTrialSchema) {}
class AcknowledgeDto extends createZodDto(AcknowledgeSalesSettlementSchema) {}
class ApprovalDto extends createZodDto(SalesApprovalRequestSchema) {}
class ClaimNoteDto extends createZodDto(SalesClaimNoteSchema) {}
class ConceptRequestDto extends createZodDto(RequestSalesConceptSchema) {}
class ImportDto extends createZodDto(SalesImportSchema) {}
class MeDto extends createZodDto(UpdateSalesMeSchema) {}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Pantallas del comercial (`/admin/sales/*`). Todo se limita a su cartera: lo
 * de otro comercial responde 404. También las puede usar un super admin (con su
 * propia cartera); el rol soporte no.
 */
@Public()
@SalesAccess()
@UseGuards(AdminGuard)
@Controller('admin/sales')
export class SalesController {
  constructor(
    private readonly accounts: SalesAccountsService,
    private readonly selling: SalesSellingService,
    private readonly commissions: SalesCommissionsService,
    private readonly notify: SalesNotifyService,
    private readonly content: SalesContentService,
    private readonly demo: SalesDemoService,
    private readonly assignment: SalesAssignmentService,
    private readonly insights: SalesInsightsService,
  ) {}

  private actor(admin: AuthenticatedSuperAdmin, req: Request): SalesActor {
    if (admin.role !== 'sales' && admin.role !== 'superadmin') {
      throw new ForbiddenException({
        code: 'sales_only',
        message: 'Estas pantallas son de los comerciales',
      });
    }
    return {
      repId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };
  }

  // ------------------------------------------------------------ yo y «Hoy»

  @Get('me')
  me(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesRepProfileDto> {
    return this.accounts.me(this.actor(admin, req).repId);
  }

  @Patch('me')
  updateMe(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: MeDto,
  ): Promise<SalesRepProfileDto> {
    return this.accounts.updateMe(this.actor(admin, req).repId, body);
  }

  @Get('today')
  today(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesTodayDto> {
    return this.accounts.today(this.actor(admin, req).repId);
  }

  // ------------------------------------------------------------------ leads

  @Get('leads')
  leads(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('filter') filter?: string,
  ): Promise<SalesLeadListDto> {
    return this.accounts.listLeads(this.actor(admin, req).repId, {
      ...(search?.trim() ? { search: search.trim().slice(0, 120) } : {}),
      ...(status ? { status } : {}),
      ...(filter ? { filter } : {}),
    });
  }

  @Post('leads')
  createProspect(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: CreateProspectDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.createProspect(actor.repId, body, actor);
  }

  @Post('leads/import')
  @HttpCode(HttpStatus.OK)
  importProspects(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: ImportDto,
  ): Promise<SalesImportResultDto> {
    const actor = this.actor(admin, req);
    return this.accounts.importProspects(actor.repId, body, actor);
  }

  // ----------------------------------------------------------------- cuenta

  @Get('accounts/:leadId')
  account(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.account(actor.repId, leadId, actor);
  }

  @Patch('accounts/:leadId')
  updateLead(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: UpdateLeadDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.updateLead(actor.repId, leadId, body, actor);
  }

  @Put('accounts/:leadId/profile')
  profile(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: ProfileDto,
  ): Promise<SalesAccountDto> {
    return this.accounts.upsertProfile(this.actor(admin, req).repId, leadId, body);
  }

  @Post('accounts/:leadId/move')
  @HttpCode(HttpStatus.OK)
  move(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: MoveDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.move(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/lose')
  @HttpCode(HttpStatus.OK)
  lose(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: LoseDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.lose(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.reopen(actor.repId, leadId, actor);
  }

  @Post('accounts/:leadId/activities')
  activity(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: ActivityDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.addActivity(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/outcome')
  outcome(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: OutcomeDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.callOutcome(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/followups')
  followup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: FollowupDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.createFollowup(actor.repId, leadId, body, actor);
  }

  @Patch('followups/:id')
  updateFollowup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateFollowupDto,
  ): Promise<PlatformLeadFollowupDto> {
    return this.accounts.updateFollowup(this.actor(admin, req).repId, id, body);
  }

  @Delete('followups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFollowup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.accounts.deleteFollowup(this.actor(admin, req).repId, id);
  }

  @Post('accounts/:leadId/email')
  email(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: EmailDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.sendEmail(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/registration-link')
  registrationLink(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.sendRegistrationLink(actor.repId, leadId, actor);
  }

  @Post('accounts/:leadId/create-tenant')
  createTenant(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CreateTenantDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.createTenant(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/quote')
  quote(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: QuoteDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.selling.sendQuote(actor.repId, leadId, body, actor);
  }

  @Post('accounts/:leadId/cadence')
  enroll(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CadenceDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.accounts.enrollCadence(actor.repId, leadId, body.cadenceId, actor);
  }

  @Delete('accounts/:leadId/cadence')
  stopCadence(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
  ): Promise<SalesAccountDto> {
    return this.accounts.stopCadence(this.actor(admin, req).repId, leadId);
  }

  @Get('accounts/:leadId/summary')
  summary(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Query('ai') ai?: string,
  ): Promise<SalesAccountSummaryDto> {
    return this.accounts.summary(this.actor(admin, req).repId, leadId, ai === '1' || ai === 'true');
  }

  // --------------------------------------------------------------- clientes

  @Get('clients')
  clients(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Query('filter') filter?: string,
  ): Promise<SalesClientRowDto[]> {
    return this.accounts.listClients(this.actor(admin, req).repId, filter);
  }

  @Post('clients/:tenantId/addon-offer')
  addonOffer(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: AddonOfferDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.selling.addonOffer(actor.repId, tenantId, body, actor);
  }

  @Post('clients/:tenantId/extend-trial')
  extendTrial(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: ExtendTrialDto,
  ): Promise<SalesAccountDto> {
    const actor = this.actor(admin, req);
    return this.selling.extendTrial(actor.repId, tenantId, body, actor);
  }

  // ------------------------------------------------------------------ vender

  @Get('catalog')
  catalog(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesCatalogDto> {
    this.actor(admin, req);
    return this.selling.catalog();
  }

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  async simulate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: SimulateDto,
  ): Promise<AdminQuoteDto> {
    const actor = this.actor(admin, req);
    const { tenantId, ...input } = body;
    if (tenantId) await this.assignment.clientOf(actor.repId, tenantId);
    return this.selling.simulate(input, tenantId ?? null);
  }

  @Get('offers')
  offers(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesOfferDto[]> {
    return this.selling.offers(this.actor(admin, req).repId);
  }

  @Get('opportunities')
  opportunities(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<AdminAddonOpportunityDto[]> {
    return this.selling.opportunities(this.actor(admin, req).repId);
  }

  @Get('approvals')
  approvals(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<AdminApprovalRequestDto[]> {
    return this.selling.myApprovals(this.actor(admin, req).repId);
  }

  @Post('approvals')
  requestApproval(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: ApprovalDto,
  ): Promise<AdminApprovalRequestDto> {
    const actor = this.actor(admin, req);
    return this.selling.requestApproval(actor.repId, body, actor);
  }

  // ------------------------------------------------------------- resultados

  @Get('claims')
  claims(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesAddonClaimDto[]> {
    return this.selling.claims(this.actor(admin, req).repId);
  }

  @Put('claims/:id/note')
  claimNote(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ClaimNoteDto,
  ): Promise<SalesAddonClaimDto[]> {
    return this.commissions.setClaimNote(this.actor(admin, req).repId, id, body.repNote);
  }

  @Get('commissions')
  commissionsView(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesCommissionsDto> {
    return this.commissions.view(this.actor(admin, req).repId);
  }

  @Post('commissions/concepts')
  requestConcept(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: ConceptRequestDto,
  ): Promise<SalesCommissionsDto> {
    return this.commissions.requestConcept(this.actor(admin, req).repId, body);
  }

  @Get('settlements')
  settlements(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesSettlementDto[]> {
    return this.commissions.settlements(this.actor(admin, req).repId);
  }

  /** Confirma que ha recibido la liquidación (en efectivo). */
  @Post('settlements/:id/received')
  @HttpCode(HttpStatus.OK)
  settlementReceived(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AcknowledgeDto,
  ): Promise<SalesSettlementDto> {
    return this.commissions.acknowledgeSettlement(this.actor(admin, req).repId, id, body.note);
  }

  /** Justificante en PDF de una liquidación suya. */
  @Get('settlements/:id/receipt')
  async settlementReceipt(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StreamableFile> {
    const pdf = await this.commissions.settlementReceiptPdf(id, this.actor(admin, req).repId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="liquidacion-${id.slice(0, 8)}.pdf"`,
    );
    return new StreamableFile(pdf, { type: 'application/pdf' });
  }

  /** Lo que cobrará por el % de sus clientes los próximos meses. */
  @Get('forecast')
  forecast(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesForecastDto> {
    return this.insights.forecast(this.actor(admin, req).repId);
  }

  @Get('targets')
  targets(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesTargetDto[]> {
    return this.commissions.targets(this.actor(admin, req).repId);
  }

  // ------------------------------------------------------------ herramientas

  @Get('materials')
  materials(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesMaterialDto[]> {
    this.actor(admin, req);
    return this.content.materials();
  }

  @Get('materials/:id/download')
  materialDownload(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    this.actor(admin, req);
    return this.content.materialDownloadUrl(id);
  }

  @Get('templates')
  templates(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesTemplateDto[]> {
    this.actor(admin, req);
    return this.content.templates(true);
  }

  @Get('cadences')
  cadences(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesCadenceDto[]> {
    this.actor(admin, req);
    return this.content.cadences(true);
  }

  @Get('demo')
  demoStatus(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SalesDemoStatusDto> {
    this.actor(admin, req);
    return this.demo.status();
  }

  @Post('demo/open')
  @HttpCode(HttpStatus.OK)
  openDemo(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<ImpersonationTokenDto> {
    const actor = this.actor(admin, req);
    return this.demo.open(actor.repId, actor);
  }

  // ---------------------------------------------------------------- avisos

  @Get('notifications')
  notifications(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('unread') unread?: string,
  ): Promise<{ items: SuperAdminNotificationDto[]; nextCursor: string | null }> {
    const repId = this.actor(admin, req).repId;
    return this.notify.page(repId, {
      ...(cursor && UUID_RE.test(cursor) ? { cursor } : {}),
      unread: unread === 'true',
    });
  }

  @Get('notifications/unread-count')
  unreadCount(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<{ count: number }> {
    return this.notify.unreadCount(this.actor(admin, req).repId);
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.notify.markRead(this.actor(admin, req).repId, id);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<void> {
    await this.notify.markAllRead(this.actor(admin, req).repId);
  }
}
