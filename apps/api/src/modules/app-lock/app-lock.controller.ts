import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  RegisterPasskeySchema,
  SetAppPinSchema,
  UnlockWithPasskeySchema,
  UnlockWithPinSchema,
  type AppLockStatusDto,
  type AppLockUnlockResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';

import { AppLockService } from './app-lock.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Request } from 'express';

class SetAppPinDto extends createZodDto(SetAppPinSchema) {}
class UnlockWithPinDto extends createZodDto(UnlockWithPinSchema) {}
class RegisterPasskeyDto extends createZodDto(RegisterPasskeySchema) {}
class UnlockWithPasskeyDto extends createZodDto(UnlockWithPasskeySchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Bloqueo de la app del panel en el móvil (Face ID / huella y PIN). Es del
 * propio usuario: no hace falta permiso especial.
 */
@Controller('me/app-lock')
export class AppLockController {
  constructor(private readonly appLock: AppLockService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser): Promise<AppLockStatusDto> {
    return this.appLock.status(user.tenantId, user.sub);
  }

  @Put('pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetAppPinDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.appLock.setPin(user.tenantId, user.sub, body.pin, extractMeta(req));
  }

  @Delete('pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePin(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    await this.appLock.removePin(user.tenantId, user.sub, extractMeta(req));
  }

  @Post('passkeys/options')
  @HttpCode(HttpStatus.OK)
  registrationOptions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return this.appLock.registrationOptions(user.tenantId, user.sub);
  }

  @Post('passkeys')
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RegisterPasskeyDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.appLock.register(
      user.tenantId,
      user.sub,
      body.response as unknown as RegistrationResponseJSON,
      body.label,
      extractMeta(req),
    );
  }

  @Delete('passkeys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePasskey(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.appLock.removePasskey(user.tenantId, user.sub, id, extractMeta(req));
  }

  @Post('unlock/options')
  @HttpCode(HttpStatus.OK)
  unlockOptions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.appLock.unlockOptions(user.tenantId, user.sub);
  }

  @ThrottleLogin()
  @Post('unlock/passkey')
  @HttpCode(HttpStatus.OK)
  unlockWithPasskey(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UnlockWithPasskeyDto,
  ): Promise<AppLockUnlockResultDto> {
    return this.appLock.unlockWithPasskey(
      user.tenantId,
      user.sub,
      body.response as unknown as AuthenticationResponseJSON,
    );
  }

  @ThrottleLogin()
  @Post('unlock/pin')
  @HttpCode(HttpStatus.OK)
  unlockWithPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UnlockWithPinDto,
    @Req() req: Request,
  ): Promise<AppLockUnlockResultDto> {
    return this.appLock.unlockWithPin(user.tenantId, user.sub, body.pin, extractMeta(req));
  }
}
