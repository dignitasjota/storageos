import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  isValidCustomDomain,
  type PlatformDomainStatusDto,
  type PlatformEmailSettingsDto,
  SendTestEmailSchema,
  type TestEmailResultDto,
  type UnusedBrevoDomainDto,
  UpdatePlatformEmailSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { PlatformEmailSettingsService } from '../email/platform-email-settings.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/providers/email-provider';
import { EmailDomainsService } from '../email-domains/email-domains.service';

import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Request } from 'express';

class UpdatePlatformEmailSettingsDto extends createZodDto(UpdatePlatformEmailSettingsSchema) {}
class SendTestEmailDto extends createZodDto(SendTestEmailSchema) {}

/**
 * Correo saliente de la plataforma: qué proveedor (Brevo / Resend) envía y si se
 * reintenta con el otro al fallar. Leer: cualquier super admin; cambiar o
 * mandar una prueba: rol superadmin.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/email-settings')
export class AdminEmailSettingsController {
  constructor(
    private readonly settings: PlatformEmailSettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly audit: SuperAdminAuditService,
    private readonly emailDomains: EmailDomainsService,
  ) {}

  /**
   * Dominios de la cuenta Brevo que ya no usa ningún tenant (la app nunca los
   * borra sola). 503 `email_domains_not_available` sin `BREVO_API_KEY`.
   */
  /** ¿Está autenticado el dominio del remitente de la plataforma en cada proveedor? */
  @Get('platform-domain')
  platformDomain(): Promise<PlatformDomainStatusDto> {
    return this.emailDomains.platformDomainStatus();
  }

  @Get('brevo-domains/unused')
  unusedBrevoDomains(): Promise<UnusedBrevoDomainDto[]> {
    return this.emailDomains.listUnusedBrevoDomains();
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
    const text = `Este es un correo de prueba enviado desde el panel de administración (${sentAt}).`;
    let res;
    try {
      res = await this.email.send({
        to: body.to,
        subject: 'Prueba de correo de TrasterOS',
        html: `<p>${text}</p>`,
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
    return { provider: res.provider ?? 'unknown', providerMessageId: res.providerMessageId };
  }
}
