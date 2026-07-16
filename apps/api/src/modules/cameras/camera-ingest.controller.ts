import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { IngestCameraEventSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';

import { CameraEventsService } from './camera-events.service';

class IngestCameraEventDto extends createZodDto(IngestCameraEventSchema) {}

/**
 * Webhook de ingesta de eventos de cámara/alarma. Público (lo llama el equipo,
 * un agente on-site o un puente DSS), autenticado por el **token de ingesta del
 * dispositivo** (`X-Camera-Token`, único, sha256 en BD). Payload normalizado
 * (ver `IngestCameraEventSchema`); el snapshot va en `imageBase64` opcional.
 */
@Public()
@Controller({ path: 'webhooks/cameras', version: VERSION_NEUTRAL })
export class CameraIngestController {
  constructor(private readonly events: CameraEventsService) {}

  @ThrottleLogin()
  @Post('events')
  @HttpCode(HttpStatus.OK)
  ingest(
    @Headers('x-camera-token') token: string | undefined,
    @Body() body: IngestCameraEventDto,
  ): Promise<{ id: string }> {
    return this.events.ingest(token, body);
  }
}
