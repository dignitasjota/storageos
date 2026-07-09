import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CreateWaitlistEntrySchema, UpdateWaitlistEntrySchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { WaitlistService } from './waitlist.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateWaitlistEntryDto extends createZodDto(CreateWaitlistEntrySchema) {}
class UpdateWaitlistEntryDto extends createZodDto(UpdateWaitlistEntrySchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.get('user-agent');
  const ip = req.ip;
  return { ...(ua ? { userAgent: ua } : {}), ...(ip ? { ipAddress: ip } : {}) };
}

@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @RequirePermission('reservations:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('facilityId') facilityId?: string,
  ) {
    return this.waitlist.list(user.tenantId, {
      ...(status ? { status } : {}),
      ...(facilityId ? { facilityId } : {}),
    });
  }

  @RequirePermission('reservations:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWaitlistEntryDto,
    @Req() req: Request,
  ) {
    return this.waitlist.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('reservations:write')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateWaitlistEntryDto,
    @Req() req: Request,
  ) {
    return this.waitlist.updateStatus({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      status: body.status,
      meta: extractMeta(req),
    });
  }
}
