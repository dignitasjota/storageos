import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type PlatformEmailSettingsDto,
  SendTestEmailSchema,
  type TestEmailResultDto,
  UpdatePlatformEmailSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { PlatformEmailSettingsService } from '../email/platform-email-settings.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/providers/email-provider';

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
  ) {}

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
