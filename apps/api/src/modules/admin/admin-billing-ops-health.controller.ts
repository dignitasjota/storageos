import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  BILLING_INVOICE_PROBLEMS,
  BILLING_NOTICE_KINDS,
  BILLING_TENANT_PROBLEMS,
  type BillingBatchResultDto,
  type BillingCertificateRowDto,
  type BillingInvoiceProblem,
  type BillingIssueDetailDto,
  type BillingIssuesPageDto,
  type BillingNoticePreviewDto,
  type BillingOtherProblemsDto,
  type BillingStuckSubmissionDto,
  type BillingTenantProblem,
  type BillingVerifactuTenantDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminBillingNoticesService } from './admin-billing-notices.service';
import {
  AdminBillingOpsHealthService,
  type BillingActionMeta,
} from './admin-billing-ops-health.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

const reasonSchema = z.string().trim().min(3, 'Indica el motivo (mínimo 3 caracteres)').max(500);

class RetryStuckDto extends createZodDto(
  z.object({ tenantId: z.string().uuid(), ownerId: z.string().uuid().nullable().default(null) }),
) {}
class ResendDto extends createZodDto(z.object({ reason: reasonSchema })) {}
class BatchDto extends createZodDto(
  z.object({
    action: z.enum(['refresh', 'resend']),
    invoiceIds: z.array(z.string().uuid()).min(1).max(50),
    reason: reasonSchema.optional(),
  }),
) {}
class NoticeDto extends createZodDto(
  z.object({
    tenantId: z.string().uuid(),
    kind: z.enum(BILLING_NOTICE_KINDS),
    message: z.string().trim().max(1000).optional(),
    credentialId: z.string().uuid().optional(),
  }),
) {}

const meta = (admin: AuthenticatedSuperAdmin, req: Request): BillingActionMeta => ({
  superAdminId: admin.sub,
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

/** Problemas de facturación: envíos atascados, Veri*Factu por tenant, incidencias y avisos. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/billing-ops')
export class AdminBillingOpsHealthController {
  constructor(
    private readonly health: AdminBillingOpsHealthService,
    private readonly notices: AdminBillingNoticesService,
  ) {}

  @Get('stuck')
  stuck(@Query('all') all?: string): Promise<BillingStuckSubmissionDto[]> {
    return this.health.stuckSubmissions({ all: all === '1' });
  }

  @RequireSuperadmin()
  @Post('stuck/retry')
  @HttpCode(HttpStatus.OK)
  retry(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: RetryStuckDto,
    @Req() req: Request,
  ): Promise<{ scheduledAt: string }> {
    return this.health.retryStuck(body.tenantId, body.ownerId, meta(admin, req));
  }

  @Get('tenants')
  tenants(
    @Query('problem') problem?: string,
    @Query('search') search?: string,
  ): Promise<BillingVerifactuTenantDto[]> {
    if (problem && !(BILLING_TENANT_PROBLEMS as readonly string[]).includes(problem)) {
      throw new BadRequestException({
        code: 'invalid_problem',
        message: 'Tipo de problema no válido',
      });
    }
    return this.health.verifactuTenants({
      problem: problem as BillingTenantProblem | undefined,
      search,
    });
  }

  @Get('issues')
  issues(
    @Query('type') type?: string,
    @Query('tenantId') tenantId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<BillingIssuesPageDto> {
    if (type && !(BILLING_INVOICE_PROBLEMS as readonly string[]).includes(type)) {
      throw new BadRequestException({
        code: 'invalid_type',
        message: 'Tipo de problema no válido',
      });
    }
    for (const id of [tenantId, cursor]) {
      if (id && !z.string().uuid().safeParse(id).success) {
        throw new BadRequestException({ code: 'invalid_id', message: 'Identificador no válido' });
      }
    }
    const n = limit ? Number(limit) : undefined;
    return this.health.issues({
      type: type as BillingInvoiceProblem | undefined,
      tenantId,
      cursor,
      limit: n !== undefined && Number.isFinite(n) ? n : undefined,
    });
  }

  @Get('invoices/:invoiceId')
  detail(@Param('invoiceId', ParseUUIDPipe) invoiceId: string): Promise<BillingIssueDetailDto> {
    return this.health.detail(invoiceId);
  }

  @Get('invoices/:invoiceId/xml')
  xml(@Param('invoiceId', ParseUUIDPipe) invoiceId: string): Promise<{ xml: string | null }> {
    return this.health.recordXml(invoiceId);
  }

  @RequireSuperadmin()
  @Post('invoices/:invoiceId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() body: ResendDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.health.resend(invoiceId, body.reason, meta(admin, req));
  }

  /** Consultar o reenviar varias facturas (reenviar: solo superadmin, con motivo). */
  @Post('invoices/batch')
  @HttpCode(HttpStatus.OK)
  batch(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: BatchDto,
    @Req() req: Request,
  ): Promise<BillingBatchResultDto> {
    if (body.action === 'resend') {
      if (admin.role !== 'superadmin') {
        throw new ForbiddenException({
          code: 'insufficient_super_admin_role',
          message: 'Reenviar facturas solo lo puede hacer un super admin',
        });
      }
      if (!body.reason) {
        throw new BadRequestException({ code: 'reason_required', message: 'Indica el motivo' });
      }
    }
    return this.health.batch(body.action, body.invoiceIds, body.reason, meta(admin, req));
  }

  @Get('certificates')
  certificates(@Query('days') days?: string): Promise<BillingCertificateRowDto[]> {
    const n = Number(days);
    return this.health.certificates(Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 60);
  }

  @Get('other')
  other(): Promise<BillingOtherProblemsDto> {
    return this.health.otherProblems();
  }

  @Post('notices/preview')
  @HttpCode(HttpStatus.OK)
  previewNotice(@Body() body: NoticeDto): Promise<BillingNoticePreviewDto> {
    return this.notices.preview(body.tenantId, body.kind, body.message, body.credentialId);
  }

  @Post('notices')
  @HttpCode(HttpStatus.OK)
  sendNotice(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: NoticeDto,
    @Req() req: Request,
  ): Promise<{ sent: number; failed: number }> {
    return this.notices.send(
      body.tenantId,
      body.kind,
      { message: body.message, credentialId: body.credentialId },
      meta(admin, req),
    );
  }
}
