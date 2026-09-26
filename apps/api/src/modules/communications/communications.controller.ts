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
  BadRequestException,
} from '@nestjs/common';
import {
  type CommunicationChannelValue,
  type CommunicationDto,
  type CommunicationStatusValue,
  SendCommunicationSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CommunicationsService, type ListFilters } from './communications.service';

class SendCommunicationDto extends createZodDto(SendCommunicationSchema) {}

@Controller('communications')
export class CommunicationsController {
  constructor(private readonly service: CommunicationsService) {}

  @RequirePermission('communications:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('leadId') leadId?: string,
    @Query('source') source?: string,
    @Query('contractId') contractId?: string,
    @Query('invoiceId') invoiceId?: string,
  ): Promise<CommunicationDto[]> {
    const filters: ListFilters = {};
    if (channel) filters.channel = channel as CommunicationChannelValue;
    if (status) filters.status = status as CommunicationStatusValue;
    if (customerId) filters.customerId = customerId;
    if (leadId) filters.leadId = leadId;
    if (source) filters.source = source;
    // Un id mal formado daría un 500 de Prisma (columna UUID): se valida aquí.
    for (const [key, value] of [
      ['contractId', contractId],
      ['invoiceId', invoiceId],
    ] as const) {
      if (!value) continue;
      if (!UUID_RE.test(value)) {
        throw new BadRequestException({ code: 'invalid_id', message: `${key} no es un UUID` });
      }
      filters[key] = value;
    }
    return this.service.list(user.tenantId, filters);
  }

  @RequirePermission('communications:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @RequirePermission('communications:send')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendCommunicationDto,
  ): Promise<CommunicationDto> {
    return this.service.sendManual({ tenantId: user.tenantId, input: body });
  }

  @Post(':id/retry')
  @RequirePermission('communications:send')
  @HttpCode(HttpStatus.OK)
  retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.retry(user.tenantId, id);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
