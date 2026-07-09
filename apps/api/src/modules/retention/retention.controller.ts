import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CreateRetentionOfferSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { RetentionService } from './retention.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateRetentionOfferDto extends createZodDto(CreateRetentionOfferSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.get('user-agent');
  const ip = req.ip;
  return { ...(ua ? { userAgent: ua } : {}), ...(ip ? { ipAddress: ip } : {}) };
}

@Controller('contracts/:contractId/retention-offers')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @RequirePermission('contracts:read')
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Param('contractId') contractId: string) {
    return this.retention.listForContract(user.tenantId, contractId);
  }

  @RequirePermission('contracts:manage')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId') contractId: string,
    @Body() body: CreateRetentionOfferDto,
    @Req() req: Request,
  ) {
    return this.retention.createOffer({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId,
      input: body,
      meta: extractMeta(req),
    });
  }
}
