import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ProposeAddonSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminOpportunitiesService } from './admin-opportunities.service';
import { AdminGuard } from './admin.guard';
import { CurrentSuperAdmin, type AuthenticatedSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { AdminAddonOpportunityDto, AdminProposeAddonResultDto } from '@storageos/shared';
import type { Request } from 'express';

class ProposeAddonDto extends createZodDto(ProposeAddonSchema) {}

/** Oportunidades de venta de extras y propuesta por correo. */
@Public()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminOpportunitiesController {
  constructor(private readonly service: AdminOpportunitiesService) {}

  @Get('opportunities')
  opportunities(): Promise<AdminAddonOpportunityDto[]> {
    return this.service.opportunities();
  }

  @RequireSuperadmin()
  @Post('tenants/:id/addon-offers')
  propose(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ProposeAddonDto,
    @Req() req: Request,
  ): Promise<AdminProposeAddonResultDto> {
    return this.service.propose(id, body, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
