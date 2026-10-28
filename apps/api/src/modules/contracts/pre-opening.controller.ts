import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { CancelPreOpeningSchema, UpdateFacilityOpeningSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PreOpeningService } from './pre-opening.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractDto,
  FacilityOpeningDto,
  FacilityOpeningResultDto,
  PreOpeningCancelPreviewDto,
} from '@storageos/shared';
import type { Request } from 'express';

class UpdateFacilityOpeningDto extends createZodDto(UpdateFacilityOpeningSchema) {}
class CancelPreOpeningDto extends createZodDto(CancelPreOpeningSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return { ...(ua ? { userAgent: ua } : {}), ...(ip ? { ipAddress: ip } : {}) };
}

/** Reservas antes de la apertura: fecha de apertura del local y cancelación. */
@Controller()
export class PreOpeningController {
  constructor(private readonly preOpening: PreOpeningService) {}

  @RequirePermission('facilities:read')
  @Get('facilities/:id/opening')
  getOpening(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<FacilityOpeningDto> {
    return this.preOpening.getOpening(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('facilities:manage')
  @Put('facilities/:id/opening')
  updateOpening(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateFacilityOpeningDto,
    @Req() req: Request,
  ): Promise<FacilityOpeningResultDto> {
    return this.preOpening.updateOpening({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      facilityScope: user.facilityScope ?? null,
      input: body,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:read')
  @Get('contracts/:id/pre-opening/cancel-preview')
  cancelPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PreOpeningCancelPreviewDto> {
    return this.preOpening.cancelPreview(user.tenantId, id, {
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('contracts:manage')
  @Post('contracts/:id/cancel-pre-opening')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelPreOpeningDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.preOpening.cancel({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      facilityScope: user.facilityScope ?? null,
      ...(body.reason ? { reason: body.reason } : {}),
      meta: extractMeta(req),
    });
  }
}
