import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AuthSuccessResponse,
  Challenge2faSchema,
  Disable2faSchema,
  Enrol2faRequiredSetupSchema,
  Enrol2faRequiredVerifySchema,
  type RecoveryCodesResponse,
  Regenerate2faRecoveryCodesSchema,
  type Setup2faResponse,
  type TwoFactorStatusResponse,
  Verify2faSetupSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { setTenantRefreshCookie } from '../../common/cookies/tenant-refresh-cookie';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Throttle2fa } from '../../common/decorators/throttle-presets';

import { TwoFactorService } from './two-factor.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Request, Response } from 'express';

class Verify2faSetupDto extends createZodDto(Verify2faSetupSchema) {}
class Disable2faDto extends createZodDto(Disable2faSchema) {}
class Regenerate2faRecoveryCodesDto extends createZodDto(Regenerate2faRecoveryCodesSchema) {}
class Challenge2faDto extends createZodDto(Challenge2faSchema) {}
class Enrol2faRequiredSetupDto extends createZodDto(Enrol2faRequiredSetupSchema) {}
class Enrol2faRequiredVerifyDto extends createZodDto(Enrol2faRequiredVerifySchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('auth/2fa')
export class TwoFactorController {
  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser): Promise<TwoFactorStatusResponse> {
    return this.twoFactor.status(user.sub);
  }

  @Post('setup')
  async setup(@CurrentUser() user: AuthenticatedUser): Promise<Setup2faResponse> {
    return this.twoFactor.setup(user.sub);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: Verify2faSetupDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesResponse> {
    return this.twoFactor.verify(user.sub, input.code, extractMeta(req));
  }

  @Throttle2fa()
  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: Disable2faDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.twoFactor.disable(user.sub, input, extractMeta(req));
  }

  @Post('recovery-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  async regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: Regenerate2faRecoveryCodesDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesResponse> {
    return this.twoFactor.regenerateRecoveryCodes(user.sub, input, extractMeta(req));
  }

  @Public()
  @Throttle2fa()
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  async challenge(
    @Body() input: Challenge2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSuccessResponse> {
    const result = await this.twoFactor.challenge(input, extractMeta(req));
    setTenantRefreshCookie(res, this.config, result.refreshToken);
    return result.body;
  }

  // ----------------- 2FA enrolment forzoso (politica tenant) ---------------
  //
  // Endpoints publicos: la autenticacion la aporta el `enrolmentToken` JWT
  // corto que devuelve el login cuando el tenant exige 2FA a roles owner|manager
  // y el user no lo tiene activo. NO se requiere JwtAuthGuard.

  @Public()
  @Throttle2fa()
  @Post('enrol-required/setup')
  @HttpCode(HttpStatus.OK)
  async enrolRequiredSetup(@Body() input: Enrol2faRequiredSetupDto): Promise<Setup2faResponse> {
    return this.twoFactor.enrolRequiredSetup(input);
  }

  @Public()
  @Throttle2fa()
  @Post('enrol-required/verify')
  @HttpCode(HttpStatus.OK)
  async enrolRequiredVerify(
    @Body() input: Enrol2faRequiredVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSuccessResponse & { recoveryCodes: string[] }> {
    const result = await this.twoFactor.enrolRequiredVerify(input, extractMeta(req));
    setTenantRefreshCookie(res, this.config, result.refreshToken);
    return result.body;
  }
}
