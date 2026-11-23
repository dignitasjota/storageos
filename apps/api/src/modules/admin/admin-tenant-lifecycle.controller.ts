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
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AdminChangeUserEmailSchema,
  AdminTenantActionSchema,
  AdminTransferOwnershipSchema,
  AnonymizeTenantSchema,
  CancelTenantSchema,
  ChargeTenantAddonNowSchema,
  ConsistencyCodeEnum,
  PinInteractionSchema,
  SubscriptionPreviewQuerySchema,
  TenantDuplicatesQuerySchema,
  UpdateTenantAddonSchema,
  VoidSaasPaymentSchema,
  type AdminAnonymizeResultDto,
  type AdminSubscriptionPreviewDto,
  type AdminTenantConsistencyDto,
  type AdminTenantCustomersPageDto,
  type AdminTenantDataExportDto,
  type AdminTenantDto,
  type AdminTenantDuplicateDto,
  type AdminTenantEmailRecipientDto,
  type AdminTenantFacilitiesPageDto,
  type TenantBillingSummaryDto,
  type TenantInteractionDto,
  type TenantSubscriptionPaymentDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminCommsService } from './admin-comms.service';
import { AdminSupportService } from './admin-support.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { AdminTenantLifecycleService } from './admin-tenant-lifecycle.service';
import { AdminTenantToolsService } from './admin-tenant-tools.service';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { TenantDataExportJobsService } from './tenant-data-export-jobs.service';

import type { Request } from 'express';

class CancelTenantDto extends createZodDto(CancelTenantSchema) {}
class ActionDto extends createZodDto(AdminTenantActionSchema) {}
class AnonymizeDto extends createZodDto(AnonymizeTenantSchema) {}
class VoidPaymentDto extends createZodDto(VoidSaasPaymentSchema) {}
class UpdateAddonDto extends createZodDto(UpdateTenantAddonSchema) {}
class ChargeNowDto extends createZodDto(ChargeTenantAddonNowSchema) {}
class ChangeEmailDto extends createZodDto(AdminChangeUserEmailSchema) {}
class TransferOwnershipDto extends createZodDto(AdminTransferOwnershipSchema) {}
class PinDto extends createZodDto(PinInteractionSchema) {}

function meta(admin: AuthenticatedSuperAdmin, req: Request) {
  return {
    superAdminId: admin.sub,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

function uuidOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (!/^[0-9a-f-]{36}$/i.test(v)) {
    throw new BadRequestException({ code: 'invalid_cursor', message: 'Cursor no válido' });
  }
  return v;
}

/**
 * Ciclo de vida del tenant en el panel del super admin: baja y anonimización
 * programadas, vista previa de las acciones sobre la suscripción, avisos de
 * incoherencias, pagos a mano y extras, correo y propiedad de los usuarios,
 * destinatarios del correo, exportaciones, notas fijadas, inquilinos y
 * locales por páginas y posibles duplicados del alta.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminTenantLifecycleController {
  constructor(
    private readonly lifecycle: AdminTenantLifecycleService,
    private readonly tenants: AdminTenantsService,
    private readonly support: AdminSupportService,
    private readonly comms: AdminCommsService,
    private readonly exports: TenantDataExportJobsService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly tools: AdminTenantToolsService,
    private readonly superAdminAudit: SuperAdminAuditService,
  ) {}

  // -------------------------------------------------------------- baja

  @RequireSuperadmin()
  @Post('tenants/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelTenantDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    return this.lifecycle.cancel(id, body, meta(admin, req));
  }

  @RequireSuperadmin()
  @Post('tenants/:id/cancel/undo')
  @HttpCode(HttpStatus.OK)
  undoCancel(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ActionDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    return this.lifecycle.undoCancel(id, body.reason, meta(admin, req));
  }

  // -------------------------------------------------------- anonimizar

  @RequireSuperadmin()
  @Post('tenants/:id/anonymize')
  @HttpCode(HttpStatus.OK)
  anonymize(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AnonymizeDto,
    @Req() req: Request,
  ): Promise<AdminAnonymizeResultDto> {
    return this.lifecycle.requestAnonymize(id, body, meta(admin, req));
  }

  @RequireSuperadmin()
  @Delete('tenants/:id/anonymize-schedule')
  cancelAnonymize(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ActionDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    return this.lifecycle.cancelAnonymize(id, body.reason, meta(admin, req));
  }

  // ------------------------------------------- suscripción: vista previa

  @Get('tenants/:id/subscription-preview')
  preview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, string>,
  ): Promise<AdminSubscriptionPreviewDto> {
    const parsed = SubscriptionPreviewQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_preview',
        message: parsed.error.issues[0]?.message ?? 'Datos no válidos',
      });
    }
    return this.lifecycle.preview(id, parsed.data);
  }

  @Get('tenants/:id/consistency')
  consistency(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantConsistencyDto> {
    return this.lifecycle.consistency(id);
  }

  @RequireSuperadmin()
  @Post('tenants/:id/consistency/:code/fix')
  @HttpCode(HttpStatus.OK)
  fixConsistency(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('code') code: string,
    @Req() req: Request,
  ): Promise<AdminTenantConsistencyDto> {
    const parsed = ConsistencyCodeEnum.safeParse(code);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_issue', message: 'Aviso no válido' });
    }
    return this.lifecycle.fixConsistency(id, parsed.data, meta(admin, req));
  }

  // ------------------------------------------- pagos a mano y extras

  @RequireSuperadmin()
  @Post('tenants/:id/saas-payments/:paymentId/void')
  @HttpCode(HttpStatus.OK)
  voidPayment(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() body: VoidPaymentDto,
    @Req() req: Request,
  ): Promise<TenantSubscriptionPaymentDto> {
    return this.lifecycle.voidPayment(id, paymentId, body.reason, meta(admin, req));
  }

  @RequireSuperadmin()
  @Patch('tenants/:id/addons/:assignmentId')
  updateAddon(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() body: UpdateAddonDto,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    return this.lifecycle.updateAddon(id, assignmentId, body, meta(admin, req));
  }

  @RequireSuperadmin()
  @Post('tenants/:id/addons/:assignmentId/charge-now')
  @HttpCode(HttpStatus.OK)
  chargeAddonNow(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() body: ChargeNowDto,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    return this.lifecycle.chargeAddonNow(id, assignmentId, body.provider, meta(admin, req));
  }

  // ------------------------------------------- usuarios: correo y propiedad

  @RequireSuperadmin()
  @Post('tenants/:id/users/:userId/change-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changeEmail(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: ChangeEmailDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.support.changeUserEmail(id, userId, body.email, {
      ...meta(admin, req),
      reason: body.reason,
    });
  }

  @RequireSuperadmin()
  @Post('tenants/:id/users/:userId/make-owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  async makeOwner(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: TransferOwnershipDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.support.transferOwnership(id, userId, { ...meta(admin, req), reason: body.reason });
  }

  // ------------------------------------------------ correo: destinatarios

  @Get('tenants/:id/email-recipients')
  emailRecipients(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminTenantEmailRecipientDto[]> {
    return this.comms.emailRecipients(id);
  }

  // ------------------------------------------------------ exportaciones

  /** Pide la exportación (se genera en segundo plano y avisa al terminar). */
  @RequireSuperadmin()
  @Post('tenants/:id/data-export')
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  async dataExport(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AdminTenantDataExportDto> {
    const row = await this.exports.request(id, admin.sub);
    await this.superAdminAudit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.data_exported',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { exportId: row.id },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return row;
  }

  @Get('tenants/:id/data-exports')
  dataExports(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantDataExportDto[]> {
    return this.exports.list(id);
  }

  @RequireSuperadmin()
  @Get('tenants/:id/data-exports/:exportId/download')
  downloadExport(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ): Promise<{ url: string }> {
    return this.exports.downloadUrl(id, exportId);
  }

  // ------------------------------------------------------- historial

  @Post('tenants/:id/interactions/:interactionId/pin')
  @HttpCode(HttpStatus.OK)
  pin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('interactionId', new ParseUUIDPipe()) interactionId: string,
    @Body() body: PinDto,
  ): Promise<TenantInteractionDto> {
    return this.interactions.pin(id, interactionId, body.pinned);
  }

  // ---------------------------------------- inquilinos y locales por páginas

  @Get('tenants/:id/customers/page')
  customersPage(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<AdminTenantCustomersPageDto> {
    return this.tenants.listCustomersPage(id, {
      cursor: uuidOrUndefined(cursor),
      limit: limit ? Number(limit) || 30 : 30,
      search: search?.slice(0, 100),
      // El documento entero solo lo ve el superadmin.
      maskDocuments: admin.role !== 'superadmin',
    });
  }

  @Get('tenants/:id/facilities/page')
  facilitiesPage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<AdminTenantFacilitiesPageDto> {
    return this.tenants.listFacilitiesPage(id, {
      cursor: uuidOrUndefined(cursor),
      limit: limit ? Number(limit) || 30 : 30,
      search: search?.slice(0, 100),
    });
  }

  // ------------------------------------------------- alta: duplicados

  @Get('tenant-duplicates')
  duplicates(@Query() query: Record<string, string>): Promise<AdminTenantDuplicateDto[]> {
    const parsed = TenantDuplicatesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_query', message: 'Datos no válidos' });
    }
    return this.tools.findDuplicates(parsed.data);
  }
}
