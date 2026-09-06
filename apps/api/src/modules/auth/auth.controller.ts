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
import { ApiTags } from '@nestjs/swagger';
import {
  type AuthSuccessResponse,
  ForgotPasswordSchema,
  type LoginRequires2faEnrolmentResponse,
  type LoginRequires2faResponse,
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
  clearTenantRefreshCookie,
  readTenantRefreshCookie,
  setTenantRefreshCookie,
} from '../../common/cookies/tenant-refresh-cookie';
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

@ApiTags('Auth')
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
  ): Promise<AuthSuccessResponse | LoginRequires2faResponse | LoginRequires2faEnrolmentResponse> {
    const result = await this.authService.login(input, this.extractMeta(req));
    if ('refreshToken' in result) {
      setTenantRefreshCookie(res, this.config, result.refreshToken);
    }
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
    const cookieValue = readTenantRefreshCookie(req);
    if (!cookieValue) {
      throw new UnauthorizedException('Refresh requerido');
    }
    const result = await this.authService.refresh(cookieValue, this.extractMeta(req));
    setTenantRefreshCookie(res, this.config, result.refreshToken);
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
    setTenantRefreshCookie(res, this.config, result.refreshToken);
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
    const cookieValue = readTenantRefreshCookie(req);
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
    clearTenantRefreshCookie(res, this.config);
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
    clearTenantRefreshCookie(res, this.config);
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
}
