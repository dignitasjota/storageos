import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SuperAdminLoginSchema,
  SuperAdminTwoFactorChallengeSchema,
  SuperAdminTwoFactorDisableSchema,
  SuperAdminTwoFactorVerifySchema,
  type SuperAdminDto,
  type SuperAdminLoginRequires2faResponse,
  type SuperAdminRecoveryCodesResponse,
  type SuperAdminRefreshResponse,
  type SuperAdminSessionDto,
  type SuperAdminSetup2faResponse,
  type SuperAdminTwoFactorStatusResponse,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { Throttle2fa, ThrottleLogin } from '../../common/decorators/throttle-presets';

import { AdminGuard } from './admin.guard';
import { CurrentSuperAdmin, type AuthenticatedSuperAdmin } from './current-super-admin.decorator';
import { SuperAdminSessionsService } from './super-admin-sessions.service';
import { SuperAdminTwoFactorService } from './super-admin-two-factor.service';
import { SuperAdminService, type SuperAdminLoginMeta } from './super-admin.service';

import type { Env } from '../../config/env.schema';
import type { Request, Response } from 'express';

class SuperAdminLoginDto extends createZodDto(SuperAdminLoginSchema) {}
class SuperAdminTwoFactorVerifyDto extends createZodDto(SuperAdminTwoFactorVerifySchema) {}
class SuperAdminTwoFactorDisableDto extends createZodDto(SuperAdminTwoFactorDisableSchema) {}
class SuperAdminTwoFactorChallengeDto extends createZodDto(SuperAdminTwoFactorChallengeSchema) {}

/**
 * Nombre y path de la cookie de refresh del super admin.
 *
 * Path acotado a `/admin` para que el navegador NO la mande con peticiones
 * a endpoints de tenant (`/auth/*`). Si en un futuro se separa el panel
 * admin a otro subdominio, basta con cambiar este path o usar otro dominio
 * en `COOKIE_DOMAIN`.
 */
const REFRESH_COOKIE_NAME = 'super_admin_refresh';
const COOKIE_PATH = '/admin';

/**
 * Auth del super admin.
 *
 * Diferencia clave con `AuthController` de tenant:
 *   - Refresh cookie acotada a path `/admin` y con `sameSite=strict`.
 *   - Login en dos pasos cuando hay 2FA (analogo al flujo de tenant pero
 *     con secret independiente y purpose='superadmin-2fa-pending').
 *   - Endpoints `2fa/*` montados aqui en lugar de en un controller aparte
 *     para mantener todas las rutas bajo `/admin/auth/*`.
 */
@Controller('admin/auth')
export class SuperAdminAuthController {
  private readonly logger = new Logger(SuperAdminAuthController.name);

  constructor(
    private readonly admins: SuperAdminService,
    private readonly twoFactor: SuperAdminTwoFactorService,
    private readonly sessions: SuperAdminSessionsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ============================== login ====================================

  @Public()
  @ThrottleLogin()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() input: SuperAdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SuperAdminSessionDto | SuperAdminLoginRequires2faResponse> {
    const result = await this.admins.login(input, this.extractMeta(req));
    if ('refreshToken' in result) {
      this.setRefreshCookie(res, result.refreshToken, result.refreshTtlSeconds);
    }
    return result.body;
  }

  // ============================ refresh ====================================

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SuperAdminRefreshResponse> {
    const cookieValue = this.readRefreshCookie(req);
    if (!cookieValue) {
      throw new UnauthorizedException({
        code: 'refresh_required',
        message: 'Refresh requerido',
      });
    }
    const result = await this.admins.refreshAccessToken(cookieValue, this.extractMeta(req));
    this.setRefreshCookie(res, result.refreshToken, result.refreshTtlSeconds);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    };
  }

  // ============================ logout =====================================

  @Public()
  @UseGuards(AdminGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const cookieValue = this.readRefreshCookie(req);
    if (cookieValue) {
      const parsed = this.sessions.parseRefreshToken(cookieValue);
      if (parsed) {
        await this.sessions.revokeSession({ sessionId: parsed.sessionId, reason: 'logout' });
      }
    }
    this.clearRefreshCookie(res);
    // El access JWT no tiene mecanismo de revocacion (TTL corto = 8h). El
    // logger nos basta como rastro.
    this.logger.log(`admin.session.revoked adminId=${admin.sub} reason=logout`);
  }

  @Public()
  @UseGuards(AdminGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revokeAll({ superAdminId: admin.sub, reason: 'logout_all' });
    this.clearRefreshCookie(res);
  }

  // ============================== me =======================================

  @Public()
  @UseGuards(AdminGuard)
  @Get('me')
  async me(@CurrentSuperAdmin() admin: AuthenticatedSuperAdmin): Promise<SuperAdminDto> {
    return this.admins.getById(admin.sub);
  }

  // ============================== 2FA ======================================

  @Public()
  @UseGuards(AdminGuard)
  @Get('2fa/status')
  async twoFactorStatus(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SuperAdminTwoFactorStatusResponse> {
    return this.twoFactor.status(admin.sub);
  }

  @Public()
  @UseGuards(AdminGuard)
  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  async twoFactorSetup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SuperAdminSetup2faResponse> {
    return this.twoFactor.setup(admin.sub);
  }

  @Public()
  @UseGuards(AdminGuard)
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  async twoFactorVerify(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() input: SuperAdminTwoFactorVerifyDto,
    @Req() req: Request,
  ): Promise<SuperAdminRecoveryCodesResponse> {
    return this.twoFactor.verify(admin.sub, input.code, this.extractMeta(req));
  }

  @Public()
  @UseGuards(AdminGuard)
  @Throttle2fa()
  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async twoFactorDisable(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() input: SuperAdminTwoFactorDisableDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.twoFactor.disable(admin.sub, input.password, this.extractMeta(req));
    // Tras desactivar 2FA revocamos todas las sesiones (incluida la actual).
    // El cliente tendra que volver a loguear: limpiamos cookie.
    this.clearRefreshCookie(res);
  }

  @Public()
  @UseGuards(AdminGuard)
  @Post('2fa/recovery-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  async twoFactorRegenerate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<SuperAdminRecoveryCodesResponse> {
    return this.twoFactor.regenerateRecoveryCodes(admin.sub, this.extractMeta(req));
  }

  @Public()
  @Throttle2fa()
  @Post('2fa/challenge')
  @HttpCode(HttpStatus.OK)
  async twoFactorChallenge(
    @Body() input: SuperAdminTwoFactorChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SuperAdminSessionDto> {
    const result = await this.twoFactor.challenge(
      input.pendingToken,
      input.code,
      this.extractMeta(req),
    );
    this.setRefreshCookie(res, result.refreshToken, result.refreshTtlSeconds);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      admin: result.admin,
    };
  }

  // ------------------------- helpers privados ------------------------------

  private extractMeta(req: Request): SuperAdminLoginMeta {
    const ua = req.header('user-agent');
    const ip = req.ip;
    return {
      ...(ua ? { userAgent: ua } : {}),
      ...(ip ? { ipAddress: ip } : {}),
    };
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    return cookies?.[REFRESH_COOKIE_NAME];
  }

  private setRefreshCookie(res: Response, token: string, ttlSeconds: number): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      // `strict` para el super admin: la cookie nunca debe acompañar
      // cross-site requests; el panel admin se sirve desde el mismo origen.
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: ttlSeconds * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, {
      path: COOKIE_PATH,
    });
  }
}
