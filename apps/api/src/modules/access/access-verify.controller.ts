import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type AccessMethodValue,
  VerifyAccessSchema,
  type VerifyAccessResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AccessVerifyService } from './access-verify.service';

import type { Request } from 'express';

class VerifyAccessDto extends createZodDto(VerifyAccessSchema) {}

const METHODS: AccessMethodValue[] = ['pin', 'qr', 'rfid'];

/**
 * Endpoint publico que usan los devices fisicos para validar un intento de
 * acceso. Se autentica via header `X-Device-Key` (argon2 hash en BD).
 *
 * Dos formas equivalentes:
 *   - `POST /access/verify` con body JSON (controlador propio, ESP32…).
 *   - `GET  /access/verify?...` para lectores que solo pueden **componer una
 *     URL** (Akuvox en modo "servidor de terceros", escáneres QR/Wiegand→HTTP):
 *     mismos datos por query; la API key va por header o por `?key=`.
 *   Response: `{ result, allowed, customerName?, reason? }`.
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
    return this.run({
      apiKey,
      method: body.method,
      credential: body.credential,
      deviceRef: body.deviceId,
      ipAddress: req.ip,
    });
  }

  /**
   * Variante GET para lectores comerciales que integran por "URL con
   * placeholders" (patrón A). Ejemplos de configuración en el lector:
   *   - PIN:  `.../v1/access/verify?key=<DEVICE_KEY>&device=<HW_ID>&pin={Pin}`
   *   - QR:   `.../v1/access/verify?key=<DEVICE_KEY>&device=<HW_ID>&qr={QRCode}`
   *   - RFID: `.../v1/access/verify?key=<DEVICE_KEY>&device=<HW_ID>&card={Card}`
   * El método se infiere del parámetro presente (o `?method=` + `?code=`).
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('verify')
  @HttpCode(HttpStatus.OK)
  async verifyGet(
    @Query() query: Record<string, string | undefined>,
    @Headers('x-device-key') keyHeader: string | undefined,
    @Req() req: Request,
  ): Promise<VerifyAccessResultDto> {
    const credential = query.code ?? query.credential ?? query.pin ?? query.qr ?? query.card;
    const method =
      query.method ?? (query.qr ? 'qr' : query.card ? 'rfid' : query.pin ? 'pin' : 'pin');
    return this.run({
      apiKey: keyHeader ?? query.key,
      method,
      credential,
      deviceRef: query.device ?? query.deviceId,
      ipAddress: req.ip,
    });
  }

  /** Lógica común de POST/GET: autentica el device y valida el intento. */
  private async run(args: {
    apiKey: string | undefined;
    method: string | undefined;
    credential: string | undefined;
    deviceRef: string | undefined;
    ipAddress: string | undefined;
  }): Promise<VerifyAccessResultDto> {
    const { apiKey, credential, deviceRef, ipAddress } = args;
    if (!apiKey) {
      throw new UnauthorizedException({
        code: 'device_key_required',
        message: 'Falta la API key del dispositivo (header X-Device-Key o ?key=)',
      });
    }
    if (!credential || !deviceRef) {
      throw new UnauthorizedException({
        code: 'verify_params_required',
        message: 'Faltan parámetros de verificación (credential/code y device)',
      });
    }
    const method = (args.method ?? 'pin') as AccessMethodValue;
    if (!METHODS.includes(method)) {
      throw new UnauthorizedException({
        code: 'invalid_method',
        message: `method debe ser uno de: ${METHODS.join(', ')}`,
      });
    }

    const device = await this.service.authenticateDevice({ deviceRef, apiKey });
    if (!device) {
      await this.service.logDeviceUnknown({ method, credential, deviceRef, ipAddress });
      // No revelamos si el device existe o si la key es incorrecta.
      throw new UnauthorizedException({
        code: 'device_authentication_failed',
        message: 'Device no autorizado',
      });
    }
    return this.service.verify({
      tenantId: device.tenantId,
      device,
      method,
      credential,
      ipAddress,
    });
  }
}
