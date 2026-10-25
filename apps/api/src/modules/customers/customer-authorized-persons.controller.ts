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
} from '@nestjs/common';
import {
  type CustomerAuthorizedPersonDto,
  CustomerAuthorizedPersonSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerAuthorizedPersonsService } from './customer-authorized-persons.service';

class AuthorizedPersonDto extends createZodDto(CustomerAuthorizedPersonSchema) {}

@Controller('customers/:customerId/authorized-persons')
export class CustomerAuthorizedPersonsController {
  constructor(private readonly service: CustomerAuthorizedPersonsService) {}

  @RequirePermission('customers:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<CustomerAuthorizedPersonDto[]> {
    return this.service.list(user.tenantId, customerId);
  }

  @RequirePermission('customers:write')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() body: AuthorizedPersonDto,
  ): Promise<CustomerAuthorizedPersonDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId,
      input: body,
    });
  }

  @RequirePermission('customers:write')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AuthorizedPersonDto,
  ): Promise<CustomerAuthorizedPersonDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId,
      id,
      input: body,
    });
  }

  @RequirePermission('customers:write')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.remove({ tenantId: user.tenantId, userId: user.sub, customerId, id });
  }
}
