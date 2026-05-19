import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AuthSuccessResponse,
  ForgotPasswordSchema,
  LoginSchema,
  type MeResponse,
  type RefreshSuccessResponse,
  type RegisterPendingResponse,
  RegisterSchema,
  ResendVerificationSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  ThrottleLogin,
  ThrottleRefresh,
  ThrottleRegister,
} from '../../common/decorators/throttle-presets';

import { AuthService, type RequestMeta } from './auth.service';
import { TokensService } from './tokens.service';

import type { Env } from '../../config/env.schema';
import type { Request, Response } from 'express';

class RegisterDto extends createZodDto(RegisterSchema) {}
class LoginDto extends createZodDto(LoginSchema) {}
class VerifyEmailDto extends createZodDto(VerifyEmailSchema) {}
class ResendVerificationDto extends createZodDto(ResendVerificationSchema) {}
class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}

const REFRESH_COOKIE_NAME = 'refresh_token';
// Path raiz: necesario para que el middleware del frontend (otro origen en
// dev: localhost:3000) pueda leer la presencia de la cookie y proteger las
// rutas autenticadas.
const COOKIE_PATH = '/';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @ThrottleRegister()
  @Post('register')
  async register(
    @Body() input: RegisterDto,
    @Req() req: Request,
  ): Promise<RegisterPendingResponse> {
    // No setea cookie: el usuario tiene que verificar su email primero.
    return this.authService.register(input, this.extractMeta(req));
  }

  @Public()
  @ThrottleLogin()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() input: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSuccessResponse> {
    const result = await this.authService.login(input, this.extractMeta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return result.body;
  }

  @Public()
  @ThrottleRefresh()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshSuccessResponse> {
    const cookieValue = this.readRefreshCookie(req);
    if (!cookieValue) {
      throw new UnauthorizedException('Refresh requerido');
    }
    const result = await this.authService.refresh(cookieValue, this.extractMeta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return result.body;
  }

  @Public()
  @ThrottleRefresh()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() input: VerifyEmailDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSuccessResponse> {
    const result = await this.authService.verifyEmail(input, this.extractMeta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return result.body;
  }

  @Public()
  @ThrottleRegister()
  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendVerification(@Body() input: ResendVerificationDto): Promise<void> {
    await this.authService.resendVerification(input);
  }

  @Public()
  @ThrottleRegister()
  @Post('password/forgot')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() input: ForgotPasswordDto, @Req() req: Request): Promise<void> {
    await this.authService.forgotPassword(input, this.extractMeta(req));
  }

  @Public()
  @ThrottleLogin()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() input: ResetPasswordDto, @Req() req: Request): Promise<void> {
    await this.authService.resetPassword(input, this.extractMeta(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const cookieValue = this.readRefreshCookie(req);
    if (cookieValue) {
      const parsed = this.tokens.parseRefreshToken(cookieValue);
      if (parsed && parsed.tenantId === user.tenantId) {
        await this.authService.logout({
          tenantId: user.tenantId,
          userId: user.sub,
          sessionId: parsed.sessionId,
        });
      }
    }
    this.clearRefreshCookie(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logoutAll({
      tenantId: user.tenantId,
      userId: user.sub,
    });
    this.clearRefreshCookie(res);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.authService.me({ tenantId: user.tenantId, userId: user.sub });
  }

  // -------------------------- helpers privados -----------------------------

  private extractMeta(req: Request): RequestMeta {
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

  private setRefreshCookie(res: Response, token: string): void {
    const ttlSeconds = this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true });
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: this.config.get('COOKIE_SAMESITE', { infer: true }),
      domain: this.config.get('COOKIE_DOMAIN', { infer: true }),
      path: COOKIE_PATH,
      maxAge: ttlSeconds * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, {
      domain: this.config.get('COOKIE_DOMAIN', { infer: true }),
      path: COOKIE_PATH,
    });
  }
}
