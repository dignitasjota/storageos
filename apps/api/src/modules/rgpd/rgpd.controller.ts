import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CreateDataSubjectRequestSchema, type DataSubjectRequestDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { RgpdService } from './rgpd.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateDataSubjectRequestDto extends createZodDto(CreateDataSubjectRequestSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('rgpd')
export class RgpdController {
  constructor(private readonly rgpd: RgpdService) {}

  @Roles('owner', 'manager')
  @Get('requests')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<DataSubjectRequestDto[]> {
    return this.rgpd.list(user.tenantId);
  }

  @Roles('owner', 'manager')
  @Post('requests')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDataSubjectRequestDto,
    @Req() req: Request,
  ): Promise<DataSubjectRequestDto> {
    return this.rgpd.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Get('customers/:id/export')
  async exportCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.rgpd.exportCustomerData(user.tenantId, id);
  }

  @Roles('owner', 'manager')
  @Post('customers/:id/anonymize')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anonymize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('requestId') requestId: string | undefined,
    @Req() req: Request,
  ): Promise<void> {
    await this.rgpd.anonymizeCustomer({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: id,
      ...(requestId ? { requestId } : {}),
      meta: extractMeta(req),
    });
  }
}
