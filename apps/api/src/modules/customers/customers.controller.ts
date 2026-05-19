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
  CreateCustomerSchema,
  type CustomerDto,
  SetKycVerifiedSchema,
  UpdateCustomerSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { CustomersService } from './customers.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateCustomerDto extends createZodDto(CreateCustomerSchema) {}
class UpdateCustomerDto extends createZodDto(UpdateCustomerSchema) {}
class SetKycVerifiedDto extends createZodDto(SetKycVerifiedSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
  ): Promise<CustomerDto[]> {
    return this.customers.list(user.tenantId, { ...(search ? { search } : {}) });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerDto> {
    return this.customers.detail(user.tenantId, id);
  }

  @Roles('owner', 'manager', 'staff')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateCustomerDto,
    @Req() req: Request,
  ): Promise<CustomerDto> {
    return this.customers.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager', 'staff')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateCustomerDto,
    @Req() req: Request,
  ): Promise<CustomerDto> {
    return this.customers.update({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.customers.softDelete({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: id,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/kyc')
  async setKyc(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetKycVerifiedDto,
    @Req() req: Request,
  ): Promise<CustomerDto> {
    return this.customers.setKycVerified({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: id,
      input,
      meta: extractMeta(req),
    });
  }
}
