import {
  Body,
  Controller,
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
  AddContractNoteSchema,
  CancelContractSchema,
  ChangeContractPriceSchema,
  type ContractDto,
  type ContractEventDto,
  ContractStatusEnum,
  CreateContractSchema,
  UpdateContractSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateContractDto extends createZodDto(CreateContractSchema) {}
class UpdateContractDto extends createZodDto(UpdateContractSchema) {}
class ChangeContractPriceDto extends createZodDto(ChangeContractPriceSchema) {}
class AddContractNoteDto extends createZodDto(AddContractNoteSchema) {}
class CancelContractDto extends createZodDto(CancelContractSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('facilityId') facilityId?: string,
    @Query('unitId') unitId?: string,
  ): Promise<ContractDto[]> {
    const parsedStatus = status ? ContractStatusEnum.parse(status) : undefined;
    return this.contracts.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(customerId ? { customerId } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(unitId ? { unitId } : {}),
    });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractDto> {
    return this.contracts.detail(user.tenantId, id);
  }

  @Get(':id/events')
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractEventDto[]> {
    return this.contracts.events(user.tenantId, id);
  }

  @Roles('owner', 'manager', 'staff')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateContractDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.create({
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
    @Body() input: UpdateContractDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.update({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/sign')
  @HttpCode(HttpStatus.OK)
  async sign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.sign({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/request-end')
  @HttpCode(HttpStatus.OK)
  async requestEnd(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.requestEnd({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  async end(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.end({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CancelContractDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.cancel({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/change-price')
  @HttpCode(HttpStatus.OK)
  async changePrice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ChangeContractPriceDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.changePrice({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager', 'staff')
  @Post(':id/notes')
  async addNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AddContractNoteDto,
    @Req() req: Request,
  ): Promise<ContractEventDto> {
    return this.contracts.addNote({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input,
      meta: extractMeta(req),
    });
  }
}
