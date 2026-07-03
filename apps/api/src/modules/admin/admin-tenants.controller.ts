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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AdminAdoptionDto,
  type AdminAtRiskDto,
  type AdminCustomDomainDto,
  type AdminOnboardingDto,
  type AdminTenantCustomerDto,
  type AdminTenantDto,
  type AdminTenantFacilityDto,
  type AdminTenantFeaturesDto,
  SetTenantFeaturesSchema,
  type AdminTenantHealthDto,
  type AdminTenantInvoicingDto,
  type AdminTenantUnitDto,
  type AdminChangePlanPreviewDto,
  type AdminTrialDto,
  type AdminTenantUserDto,
  AdminTenantActionSchema,
  AdminUpdateTenantSchema,
  ChangePlanSchema,
  CreateManualSaasPaymentSchema,
  CreateTenantFollowupSchema,
  CreateTenantInteractionSchema,
  type TenantFollowupDto,
  ExtendTrialSchema,
  type ImpersonationTokenDto,
  ImpersonateSchema,
  type TenantInteractionDto,
  type TenantSubscriptionPaymentDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { BillingSaasService } from '../billing-saas/billing-saas.service';

import { AdminSupportService } from './admin-support.service';
import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { type AnonymizeTenantResult, AdminTenantsService } from './admin-tenants.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { ImpersonationService } from './impersonation.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Request } from 'express';

class AdminTenantActionDto extends createZodDto(AdminTenantActionSchema) {}
class ExtendTrialDto extends createZodDto(ExtendTrialSchema) {}
class ChangePlanDto extends createZodDto(ChangePlanSchema) {}
class ImpersonateDto extends createZodDto(ImpersonateSchema) {}
class CreateTenantInteractionDto extends createZodDto(CreateTenantInteractionSchema) {}
class CreateTenantFollowupDto extends createZodDto(CreateTenantFollowupSchema) {}
class CreateManualSaasPaymentDto extends createZodDto(CreateManualSaasPaymentSchema) {}
class AdminUpdateTenantDto extends createZodDto(AdminUpdateTenantSchema) {}
class SetTenantFeaturesDto extends createZodDto(SetTenantFeaturesSchema) {}

interface RequestMetaInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

function extractMeta(req: Request): RequestMetaInfo {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

@Public()
@UseGuards(AdminGuard)
@Controller('admin/tenants')
export class AdminTenantsController {
  constructor(
    private readonly tenants: AdminTenantsService,
    private readonly impersonation: ImpersonationService,
    private readonly saasBilling: BillingSaasService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly followups: AdminTenantFollowupsService,
    private readonly audit: SuperAdminAuditService,
    private readonly support: AdminSupportService,
  ) {}

  /** Edita datos básicos del tenant (soporte). */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminUpdateTenantDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    await this.support.updateTenant(id, input, { superAdminId: admin.sub, ...meta });
    return this.tenants.detail(id);
  }

  /** Reenvía la verificación de email de un usuario del tenant. */
  @Post(':id/users/:userId/resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.support.resendVerification(id, userId, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
    return { ok: true };
  }

  /** Envía un email de restablecimiento de contraseña a un usuario del tenant. */
  @Post(':id/users/:userId/password-reset')
  @HttpCode(HttpStatus.OK)
  async passwordReset(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.support.sendPasswordReset(id, userId, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
    return { ok: true };
  }

  /** Cierra todas las sesiones de un usuario del tenant. */
  @Post(':id/users/:userId/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  async revokeSessions(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ): Promise<{ revoked: number }> {
    const revoked = await this.support.revokeSessions(id, userId, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
    return { revoked };
  }

  /** Desactiva el 2FA de un usuario del tenant (recuperación de cuenta). */
  @Post(':id/users/:userId/disable-2fa')
  @HttpCode(HttpStatus.OK)
  async disableTwoFactor(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.support.disableTwoFactor(id, userId, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
    return { ok: true };
  }

  /** Desactiva un usuario del tenant (cierra sus sesiones). */
  @Post(':id/users/:userId/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivateUser(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.support.setUserActive(id, userId, false, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
    return { ok: true };
  }

  /** Reactiva un usuario del tenant. */
  @Post(':id/users/:userId/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivateUser(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.support.setUserActive(id, userId, true, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
    return { ok: true };
  }

  /** Histórico de conversaciones del super admin con el tenant. */
  @Get(':id/interactions')
  async listInteractions(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TenantInteractionDto[]> {
    return this.interactions.list(id);
  }

  /** Seguimientos/recordatorios sobre el tenant. */
  @Get(':id/followups')
  async listFollowups(@Param('id', new ParseUUIDPipe()) id: string): Promise<TenantFollowupDto[]> {
    return this.followups.listForTenant(id);
  }

  /** Crea un seguimiento/recordatorio sobre el tenant. */
  @Post(':id/followups')
  async createFollowup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateTenantFollowupDto,
    @Req() req: Request,
  ): Promise<TenantFollowupDto> {
    const meta = extractMeta(req);
    const created = await this.followups.create({ tenantId: id, superAdminId: admin.sub, input });
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.followup_created',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { followupId: created.id, dueDate: created.dueDate },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return created;
  }

  /** Registra una conversación (llamada/email/reunión/nota) con el tenant. */
  @Post(':id/interactions')
  async createInteraction(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateTenantInteractionDto,
    @Req() req: Request,
  ): Promise<TenantInteractionDto> {
    const meta = extractMeta(req);
    const created = await this.interactions.create({
      tenantId: id,
      superAdminId: admin.sub,
      input,
    });
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.interaction_created',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { interactionId: created.id, type: created.type },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return created;
  }

  /** Borra una conversación registrada. */
  @Delete(':id/interactions/:interactionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeInteraction(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('interactionId', new ParseUUIDPipe()) interactionId: string,
    @Req() req: Request,
  ): Promise<void> {
    const meta = extractMeta(req);
    await this.interactions.remove(id, interactionId);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.interaction_deleted',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { interactionId },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  /** Historial de pagos de la suscripción SaaS del tenant (desde BD). */
  @Get(':id/saas-payments')
  async saasPayments(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TenantSubscriptionPaymentDto[]> {
    return this.saasBilling.listSaasPayments(id);
  }

  /** Sincroniza los pagos de la suscripción desde Stripe (backfill idempotente). */
  @Post(':id/saas-payments/sync')
  @HttpCode(HttpStatus.OK)
  async syncSaasPayments(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ synced: number }> {
    return this.saasBilling.syncSaasPaymentsFromStripe(id);
  }

  /** Registra un pago manual (efectivo/transferencia/…) y extiende el periodo. */
  @Post(':id/saas-payments/manual')
  @HttpCode(HttpStatus.CREATED)
  async createManualSaasPayment(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateManualSaasPaymentDto,
    @Req() req: Request,
  ): Promise<TenantSubscriptionPaymentDto> {
    const meta = extractMeta(req);
    const payment = await this.saasBilling.recordManualPayment({
      tenantId: id,
      provider: input.provider,
      amount: input.amount,
      discount: input.discount,
      currency: input.currency,
      durationMonths: input.durationMonths,
      extendsPeriod: input.extendsPeriod,
      ...(input.paidAt ? { paidAt: new Date(input.paidAt) } : {}),
      description: input.description,
    });
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.saas_payment_manual_created',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: {
        paymentId: payment.id,
        provider: payment.provider,
        amount: payment.amount,
        durationMonths: input.durationMonths,
        periodEnd: payment.periodEnd,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return payment;
  }

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('status') status?: string,
  ): Promise<AdminTenantDto[]> {
    return this.tenants.list({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
    });
  }

  /** Tenants en riesgo (retención): trials por expirar, past_due, inactivos. */
  @Get('at-risk')
  async atRisk(): Promise<AdminAtRiskDto> {
    return this.tenants.getAtRisk();
  }

  /** Todos los trials, ordenados por expiración (gestión/conversión). */
  @Get('trials')
  async trials(): Promise<AdminTrialDto[]> {
    return this.tenants.listTrials();
  }

  /** Health score 0-100 de cada tenant (más urgente primero). */
  @Get('health')
  async health(): Promise<AdminTenantHealthDto[]> {
    return this.tenants.getTenantsHealth();
  }

  /** Adopción de features + candidatos a upgrade. */
  @Get('adoption')
  async adoption(): Promise<AdminAdoptionDto> {
    return this.tenants.getAdoption();
  }

  /** Cola de dominios propios (pendientes de activar + activos). */
  @Get('custom-domains')
  async customDomains(): Promise<AdminCustomDomainDto[]> {
    return this.tenants.listCustomDomains();
  }

  /** Activa el dominio propio de un tenant (tras configurar NPM + SSL). */
  @Post(':id/custom-domain/verify')
  @HttpCode(HttpStatus.OK)
  async verifyCustomDomain(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AdminCustomDomainDto> {
    const meta = extractMeta(req);
    return this.tenants.verifyCustomDomain(id, {
      superAdminId: admin.sub,
      reason: 'custom_domain_verify',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  /** Desactiva el dominio propio de un tenant. */
  @Post(':id/custom-domain/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeCustomDomain(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AdminCustomDomainDto> {
    const meta = extractMeta(req);
    return this.tenants.revokeCustomDomain(id, {
      superAdminId: admin.sub,
      reason: 'custom_domain_revoke',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantDto> {
    return this.tenants.detail(id);
  }

  /** Health score de un tenant concreto (desglose por factor). */
  @Get(':id/health')
  async tenantHealth(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantHealthDto> {
    return this.tenants.getTenantHealth(id);
  }

  /** Usuarios (staff) del tenant — para el desglose de la card «Uso». */
  @Get(':id/users')
  async users(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantUserDto[]> {
    return this.tenants.listUsers(id);
  }

  /** Facturación del negocio del tenant (totales + serie mensual). */
  @Get(':id/invoicing')
  async invoicing(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantInvoicingDto> {
    return this.tenants.getInvoicing(id);
  }

  /** Inquilinos del tenant (desglose de la card «Uso»). */
  @Get(':id/customers')
  async customers(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantCustomerDto[]> {
    return this.tenants.listCustomers(id);
  }

  /** Locales del tenant (drill-down de la card «Uso»). */
  @Get(':id/facilities')
  async facilities(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminTenantFacilityDto[]> {
    return this.tenants.listFacilities(id);
  }

  /** Trasteros de un local del tenant. */
  @Get(':id/facilities/:facilityId/units')
  async facilityUnits(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('facilityId', new ParseUUIDPipe()) facilityId: string,
  ): Promise<AdminTenantUnitDto[]> {
    return this.tenants.listUnits(id, facilityId);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminTenantActionDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.suspend(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminTenantActionDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.reactivate(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/extend-trial')
  @HttpCode(HttpStatus.OK)
  async extendTrial(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ExtendTrialDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.extendTrial(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      days: input.days,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Get(':id/onboarding')
  async getOnboarding(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminOnboardingDto> {
    return this.tenants.getOnboarding(id);
  }

  @Get(':id/features')
  async getFeatures(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantFeaturesDto> {
    return this.tenants.getFeatures(id);
  }

  @Put(':id/features')
  @HttpCode(HttpStatus.OK)
  async setFeatures(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetTenantFeaturesDto,
    @Req() req: Request,
  ): Promise<AdminTenantFeaturesDto> {
    const meta = extractMeta(req);
    return this.tenants.setFeatures(id, {
      superAdminId: admin.sub,
      reason: 'feature_override',
      overrides: input.overrides,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Get(':id/change-plan-preview')
  async changePlanPreview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('planSlug') planSlug: string,
  ): Promise<AdminChangePlanPreviewDto> {
    return this.tenants.changePlanPreview(id, planSlug);
  }

  @Post(':id/change-plan')
  @HttpCode(HttpStatus.OK)
  async changePlan(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ChangePlanDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.changePlan(id, {
      superAdminId: admin.sub,
      planSlug: input.planSlug,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/anonymize')
  @HttpCode(HttpStatus.OK)
  async anonymize(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminTenantActionDto,
    @Req() req: Request,
  ): Promise<AnonymizeTenantResult> {
    const meta = extractMeta(req);
    return this.tenants.anonymize(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/impersonate')
  @HttpCode(HttpStatus.OK)
  async impersonate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ImpersonateDto,
    @Req() req: Request,
  ): Promise<ImpersonationTokenDto> {
    const meta = extractMeta(req);
    return this.impersonation.impersonate({
      superAdminId: admin.sub,
      tenantId: id,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
