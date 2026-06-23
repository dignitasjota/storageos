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
  Req,
} from '@nestjs/common';
import {
  type AutomationRuleDto,
  CreateAutomationRuleSchema,
  UpdateAutomationRuleSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AutomationsService } from './automations.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateAutomationRuleDto extends createZodDto(CreateAutomationRuleSchema) {}
class UpdateAutomationRuleDto extends createZodDto(UpdateAutomationRuleSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('automations')
@RequireFeature('automations')
export class AutomationsController {
  constructor(private readonly service: AutomationsService) {}

  @RequirePermission('automations:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<AutomationRuleDto[]> {
    return this.service.list(user.tenantId);
  }

  @Post()
  @RequirePermission('automations:manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAutomationRuleDto,
    @Req() req: Request,
  ): Promise<AutomationRuleDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id')
  @RequirePermission('automations:manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAutomationRuleDto,
    @Req() req: Request,
  ): Promise<AutomationRuleDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Delete(':id')
  @RequirePermission('automations:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }
}
