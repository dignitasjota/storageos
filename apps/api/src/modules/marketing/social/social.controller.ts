import { Body, Controller, Delete, Get, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  ConnectSocialSchema,
  type SocialReportDto,
  type SocialSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AuditService } from '../../auth/audit.service';

import { SocialService } from './social.service';

import type { Request, Response } from 'express';

class ConnectSocialDto extends createZodDto(ConnectSocialSchema) {}

/** Instagram y Facebook orgánico del tenant. Dentro de Web Premium. */
// Ver la conexión y desconectar no piden Web Premium: sin el extra se puede
// borrar lo guardado (el token de Meta, por ejemplo).

@Controller('marketing/social')
export class SocialController {
  constructor(
    private readonly social: SocialService,
    private readonly audit: AuditService,
  ) {}

  /** Constancia de quién conecta o quita la cuenta (sin credenciales). */
  private trace(
    user: AuthenticatedUser,
    req: Request,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action,
      entityType: 'Tenant',
      entityId: user.tenantId,
      changes: changes as never,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @RequirePermission('marketing:read')
  @Get()
  settings(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    return this.social.settings(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @RequireFeature('web_premium')
  @Put()
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Body() body: ConnectSocialDto,
  ): Promise<SocialSettingsDto> {
    const result = await this.social.connect(user.tenantId, body);
    await this.trace(user, req, 'marketing.social_connected', { pageId: result.pageId ?? null });
    return result;
  }

  /** «Conectar con Facebook»: la dirección de Meta a la que ir. */
  @RequirePermission('marketing:manage')
  @RequireFeature('web_premium')
  @Get('oauth/start')
  oauthStart(@CurrentUser() user: AuthenticatedUser): { url: string } {
    return this.social.oauthStart(user.tenantId, user.sub);
  }

  /** Vuelta de Meta (la abre el navegador): el `state` firmado dice de qué negocio es. */
  @Public()
  @Get('oauth/callback')
  async oauthCallback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    res.redirect(302, await this.social.oauthCallback({ code, state, error }));
  }

  @RequirePermission('marketing:manage')
  @Delete()
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<SocialSettingsDto> {
    const result = await this.social.disconnect(user.tenantId);
    await this.trace(user, req, 'marketing.social_disconnected', {});
    return result;
  }

  /** Descarga ya los últimos días (sin esperar al cron). */
  @RequirePermission('marketing:manage')
  @RequireFeature('web_premium')
  @Post('sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    await this.social.sync(user.tenantId);
    return this.social.settings(user.tenantId);
  }

  @RequirePermission('marketing:read')
  @RequireFeature('web_premium')
  @Get('report')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<SocialReportDto> {
    return this.social.report(user.tenantId, Number(days) || 30);
  }
}
