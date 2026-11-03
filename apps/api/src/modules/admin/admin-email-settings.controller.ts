import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type EmailUsageDto,
  type EmailSuppressionDto,
  isValidCustomDomain,
  renderAdminEmail,
  type PlatformDomainStatusDto,
  type PlatformSendersDto,
  type PlatformEmailSettingsDto,
  SendTestEmailSchema,
  type TestEmailResultDto,
  type UnusedBrevoDomainDto,
  UpdatePlatformEmailSettingsSchema,
  UpdatePlatformSendersSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { TtlCache } from '../../common/cache/ttl-cache';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailSuppressionsService } from '../email/email-suppressions.service';
import { EmailService } from '../email/email.service';
import { PlatformEmailSettingsService } from '../email/platform-email-settings.service';
import { EmailDomainsService } from '../email-domains/email-domains.service';

import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Request } from 'express';

class UpdatePlatformEmailSettingsDto extends createZodDto(UpdatePlatformEmailSettingsSchema) {}
class SendTestEmailDto extends createZodDto(SendTestEmailSchema) {}
class UpdatePlatformSendersDto extends createZodDto(UpdatePlatformSendersSchema) {}

/**
 * Correo saliente de la plataforma: qué proveedor (Brevo / Resend) envía y si se
 * reintenta con el otro al fallar. Leer: cualquier super admin; cambiar o
 * mandar una prueba: rol superadmin.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/email-settings')
export class AdminEmailSettingsController {
  /** Brevo y Resend tardan: el estado de los dominios se guarda 5 minutos. */
  private readonly providerCache = new TtlCache<unknown>(
    process.env.NODE_ENV === 'test' ? 0 : 5 * 60_000,
  );

  constructor(
    private readonly settings: PlatformEmailSettingsService,
    private readonly mail: EmailService,
    private readonly audit: SuperAdminAuditService,
    private readonly emailDomains: EmailDomainsService,
    private readonly suppressions: EmailSuppressionsService,
    private readonly admin: PrismaAdminService,
  ) {}

  /**
   * Correos de las últimas 24 horas por proveedor (plataforma e inquilinos),
   * cuántos salieron por el respaldo y los créditos que le quedan a Brevo.
   */
  @Get('usage')
  async usage(@Query('refresh') refresh?: string): Promise<EmailUsageDto> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [platform, tenants, order, account] = await Promise.all([
      this.admin.platformEmailLog.groupBy({
        by: ['provider', 'status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.admin.communication.groupBy({
        by: ['provider', 'status'],
        where: { channel: 'email', createdAt: { gte: since }, provider: { not: null } },
        _count: { _all: true },
      }),
      this.settings.sendOrder(),
      (async () => {
        if (refresh === '1') this.providerCache.clear();
        return this.providerCache.get('brevo-account', () =>
          this.emailDomains.brevoAccount(),
        ) as Promise<{ credits: number | null; plan: string | null } | null>;
      })(),
    ]);
    const primary = order[0] ?? 'smtp';
    const by = new Map<string, { sent: number; failed: number; bounced: number }>();
    for (const row of [...platform, ...tenants]) {
      const provider = row.provider || 'desconocido';
      const cur = by.get(provider) ?? { sent: 0, failed: 0, bounced: 0 };
      const n = row._count._all;
      if (row.status === 'failed') cur.failed += n;
      else if (row.status === 'bounced') cur.bounced += n;
      else if (row.status === 'sent' || row.status === 'delivered') cur.sent += n;
      by.set(provider, cur);
    }
    const providers = [...by.entries()]
      .map(([provider, c]) => ({ provider, ...c }))
      .sort((a, b) => b.sent - a.sent);
    const viaFallback = providers
      .filter((p) => p.provider !== primary && ['brevo', 'resend'].includes(p.provider))
      .reduce((n, p) => n + p.sent, 0);
    return {
      primary,
      providers,
      viaFallback,
      brevoCreditsLeft: account?.credits ?? null,
      brevoPlan: account?.plan ?? null,
    };
  }

  /**
   * Dominios de la cuenta Brevo que ya no usa ningún tenant (la app nunca los
   * borra sola). 503 `email_domains_not_available` sin `BREVO_API_KEY`.
   */
  /** ¿Están autenticados en cada proveedor los dominios de los remitentes de la plataforma? */
  @Get('platform-domain')
  async platformDomain(@Query('refresh') refresh?: string): Promise<PlatformDomainStatusDto[]> {
    if (refresh === '1') this.providerCache.clear();
    const senders = await this.settings.getSenders();
    const domains = Object.values(senders.effective).map((s) => s.email.split('@')[1] ?? '');
    return this.providerCache.get(`domains:${[...new Set(domains)].sort().join(',')}`, () =>
      this.emailDomains.platformDomainStatus(domains),
    ) as Promise<PlatformDomainStatusDto[]>;
  }

  /** Remitentes de los correos de la plataforma (común y por tipo de correo). */
  @Get('senders')
  senders(): Promise<PlatformSendersDto> {
    return this.settings.getSenders();
  }

  @RequireSuperadmin()
  @Put('senders')
  async updateSenders(
    @Body() body: UpdatePlatformSendersDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<PlatformSendersDto> {
    const result = await this.settings.updateSenders(body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.email_senders.updated',
      targetType: 'platform_email_settings',
      changes: { senders: body },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  /** Lista de supresión: direcciones que rebotan o marcaron spam. */
  @Get('suppressions')
  suppressionList(
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ items: EmailSuppressionDto[]; nextCursor: string | null }> {
    return this.suppressions.list({
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });
  }

  /** Quita una dirección de la lista (p. ej. el buzón vuelve a funcionar). */
  @RequireSuperadmin()
  @Delete('suppressions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSuppression(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const removed = await this.suppressions.remove(id);
    if (!removed) {
      throw new NotFoundException({ code: 'suppression_not_found', message: 'No encontrada' });
    }
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.email_suppression.removed',
      targetType: 'email_suppression',
      changes: { id },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }

  @Get('brevo-domains/unused')
  unusedBrevoDomains(@Query('refresh') refresh?: string): Promise<UnusedBrevoDomainDto[]> {
    if (refresh === '1') this.providerCache.clear();
    return this.providerCache.get('brevo-unused', () =>
      this.emailDomains.listUnusedBrevoDomains(),
    ) as Promise<UnusedBrevoDomainDto[]>;
  }

  @RequireSuperadmin()
  @Delete('brevo-domains/:domain')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBrevoDomain(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('domain') domain: string,
    @Req() req: Request,
  ): Promise<void> {
    if (!isValidCustomDomain(domain)) {
      throw new BadRequestException({ code: 'invalid_domain', message: 'Dominio no válido.' });
    }
    await this.emailDomains.deleteUnusedBrevoDomain(domain);
    this.providerCache.clear();
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.brevo_domain.deleted',
      targetType: 'brevo_domain',
      changes: { domain: domain.toLowerCase() },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }

  @Get()
  get(): Promise<PlatformEmailSettingsDto> {
    return this.settings.get();
  }

  @RequireSuperadmin()
  @Put()
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: UpdatePlatformEmailSettingsDto,
    @Req() req: Request,
  ): Promise<PlatformEmailSettingsDto> {
    const result = await this.settings.update(body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.email_settings.updated',
      targetType: 'platform_email_settings',
      changes: { provider: body.provider, fallbackEnabled: body.fallbackEnabled },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  @RequireSuperadmin()
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async test(@Body() body: SendTestEmailDto): Promise<TestEmailResultDto> {
    const sentAt = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    const { html, text } = renderAdminEmail(
      `Este es un correo de prueba enviado desde el panel de administración (${sentAt}).`,
    );
    let res;
    try {
      // Por el servicio común: queda en «Correos enviados» con la marca de TrasterOS.
      res = await this.mail.sendRendered({
        to: body.to,
        kind: 'admin_alert',
        subject: 'Prueba de correo de TrasterOS',
        html,
        text,
      });
    } catch (err) {
      // El mensaje del proveedor (sin claves) ayuda a diagnosticar: dominio no
      // autenticado, cupo agotado, clave inválida…
      throw new BadGatewayException({
        code: 'email_send_failed',
        message: `No se pudo enviar: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (res.suppressed) {
      throw new BadGatewayException({ code: 'email_suppressed', message: res.suppressed });
    }
    return { provider: res.provider ?? 'unknown', providerMessageId: res.providerMessageId };
  }
}
