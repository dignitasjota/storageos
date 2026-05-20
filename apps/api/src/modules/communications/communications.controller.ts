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
import { Roles } from '../../common/decorators/roles.decorator';

import { CommunicationsService, type ListFilters } from './communications.service';

class SendCommunicationDto extends createZodDto(SendCommunicationSchema) {}

@Controller('communications')
export class CommunicationsController {
  constructor(private readonly service: CommunicationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('leadId') leadId?: string,
    @Query('source') source?: string,
  ): Promise<CommunicationDto[]> {
    const filters: ListFilters = {};
    if (channel) filters.channel = channel as CommunicationChannelValue;
    if (status) filters.status = status as CommunicationStatusValue;
    if (customerId) filters.customerId = customerId;
    if (leadId) filters.leadId = leadId;
    if (source) filters.source = source;
    return this.service.list(user.tenantId, filters);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @Roles('owner', 'manager', 'staff')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendCommunicationDto,
  ): Promise<CommunicationDto> {
    return this.service.sendManual({ tenantId: user.tenantId, input: body });
  }

  @Post(':id/retry')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CommunicationDto> {
    return this.service.retry(user.tenantId, id);
  }
}
