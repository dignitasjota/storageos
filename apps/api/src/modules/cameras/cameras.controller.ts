import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type CameraControlResultDto,
  CameraEventKindEnum,
  type CameraDeviceDto,
  type CameraDeviceWithTokenDto,
  type CameraEventDto,
  CreateCameraDeviceSchema,
  CreateIncidentFromEventSchema,
  type IncidentDto,
  LinkCameraEventSchema,
  UpdateCameraDeviceSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CameraControlService } from './camera-control.service';
import { CameraDevicesService } from './camera-devices.service';
import { CameraEventsService } from './camera-events.service';

import type { Request } from 'express';

class CreateCameraDeviceDto extends createZodDto(CreateCameraDeviceSchema) {}
class UpdateCameraDeviceDto extends createZodDto(UpdateCameraDeviceSchema) {}
class CreateIncidentFromEventDto extends createZodDto(CreateIncidentFromEventSchema) {}
class LinkCameraEventDto extends createZodDto(LinkCameraEventSchema) {}

function meta(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ...(req.ip ? { ipAddress: req.ip } : {}),
    ...(req.header('user-agent') ? { userAgent: req.header('user-agent') as string } : {}),
  };
}

/**
 * Cámaras/alarma (staff): CRUD de dispositivos + feed de eventos. La ingesta de
 * eventos es un webhook público aparte (`CameraIngestController`) — NO gateado
 * por la feature, para que el hardware siga empujando eventos aunque el plan la
 * suspenda (mismo criterio que `/access/verify`: cortar la feature no rompe la
 * operación física ya configurada).
 */
@RequireFeature('cameras')
@Controller('cameras')
export class CamerasController {
  constructor(
    private readonly devices: CameraDevicesService,
    private readonly events: CameraEventsService,
    private readonly control: CameraControlService,
  ) {}

  @RequirePermission('access:read')
  @Get('devices')
  listDevices(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CameraDeviceDto[]> {
    return this.devices.list(user.tenantId, user.facilityScope ?? null, facilityId);
  }

  @RequirePermission('access:manage')
  @Post('devices')
  createDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCameraDeviceDto,
    @Req() req: Request,
  ): Promise<CameraDeviceWithTokenDto> {
    return this.devices.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: meta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('access:manage')
  @Patch('devices/:id')
  updateDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCameraDeviceDto,
    @Req() req: Request,
  ): Promise<CameraDeviceDto> {
    return this.devices.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: meta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('access:manage')
  @Post('devices/:id/regenerate-token')
  @HttpCode(HttpStatus.OK)
  regenerateToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<CameraDeviceWithTokenDto> {
    return this.devices.regenerateToken({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: meta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Captura un fotograma bajo demanda (lo guarda como evento). */
  @RequirePermission('access:manage')
  @Post('devices/:id/snapshot')
  @HttpCode(HttpStatus.OK)
  snapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraControlResultDto> {
    return this.control.snapshot(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Arma la alarma del equipo/NVR. */
  @RequirePermission('access:manage')
  @Post('devices/:id/arm')
  @HttpCode(HttpStatus.OK)
  arm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraControlResultDto> {
    return this.control.arm(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Desarma la alarma del equipo/NVR. */
  @RequirePermission('access:manage')
  @Post('devices/:id/disarm')
  @HttpCode(HttpStatus.OK)
  disarm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraControlResultDto> {
    return this.control.disarm(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('access:manage')
  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.devices.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: meta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('access:read')
  @Get('events')
  listEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('kind') kind?: string,
    @Query('incidentId') incidentId?: string,
  ): Promise<CameraEventDto[]> {
    const parsedKind = CameraEventKindEnum.safeParse(kind);
    return this.events.list(user.tenantId, {
      facilityScope: user.facilityScope ?? null,
      ...(facilityId ? { facilityId } : {}),
      ...(parsedKind.success ? { kind: parsedKind.data } : {}),
      ...(incidentId ? { incidentId } : {}),
    });
  }

  /** Crear una incidencia a partir de un evento (alarma) y vincularla. */
  @RequirePermission('access:manage')
  @Post('events/:id/incident')
  createIncident(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateIncidentFromEventDto,
    @Req() req: Request,
  ): Promise<IncidentDto> {
    return this.events.createIncidentFromEvent({
      tenantId: user.tenantId,
      userId: user.sub,
      eventId: id,
      input: body,
      meta: meta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Vincular un evento a una incidencia existente. */
  @RequirePermission('access:manage')
  @Post('events/:id/link')
  linkIncident(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LinkCameraEventDto,
  ): Promise<CameraEventDto> {
    return this.events.linkToIncident({
      tenantId: user.tenantId,
      eventId: id,
      incidentId: body.incidentId,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Desvincular un evento de su incidencia. */
  @RequirePermission('access:manage')
  @Delete('events/:id/incident')
  unlinkIncident(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CameraEventDto> {
    return this.events.unlinkFromIncident(user.tenantId, id, user.facilityScope ?? null);
  }
}
