import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { VerifyAccessSchema, type VerifyAccessResultDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AccessVerifyService } from './access-verify.service';

import type { Request } from 'express';

class VerifyAccessDto extends createZodDto(VerifyAccessSchema) {}

/**
 * Endpoint publico que usan los devices fisicos para validar un intento de
 * acceso. Se autentica via header `X-Device-Key` (argon2 hash en BD).
 *
 *   POST /access/verify
 *   Headers: X-Device-Key: <plaintext>
 *   Body:    { method, credential, deviceId }
 *   Response: { result, allowed, customerName?, reason? }
 */
@Controller('access')
export class AccessVerifyController {
  constructor(private readonly service: AccessVerifyService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Body() body: VerifyAccessDto,
    @Headers('x-device-key') apiKey: string | undefined,
    @Req() req: Request,
  ): Promise<VerifyAccessResultDto> {
    if (!apiKey) {
      throw new UnauthorizedException({
        code: 'device_key_required',
        message: 'Falta header X-Device-Key',
      });
    }
    const device = await this.service.authenticateDevice({
      deviceRef: body.deviceId,
      apiKey,
    });
    if (!device) {
      await this.service.logDeviceUnknown({
        method: body.method,
        credential: body.credential,
        deviceRef: body.deviceId,
        ipAddress: req.ip,
      });
      // No revelamos si el device existe o si la key es incorrecta.
      throw new UnauthorizedException({
        code: 'device_authentication_failed',
        message: 'Device no autorizado',
      });
    }
    return this.service.verify({
      tenantId: device.tenantId,
      device,
      method: body.method,
      credential: body.credential,
      ipAddress: req.ip,
    });
  }
}
