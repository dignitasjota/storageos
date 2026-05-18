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
  LoginSchema,
  type MeResponse,
  type RefreshSuccessResponse,
  RegisterSchema,
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

const REFRESH_COOKIE_NAME = 'refresh_token';
const COOKIE_PATH = '/auth';

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
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSuccessResponse> {
    const result = await this.authService.register(input, this.extractMeta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return result.body;
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
