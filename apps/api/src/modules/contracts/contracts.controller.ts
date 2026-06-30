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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  AddContractNoteSchema,
  AssignInsuranceSchema,
  CancelContractSchema,
  ChangeContractPriceSchema,
  type ContractDto,
  type ContractEventDto,
  ContractStatusEnum,
  CreateContractSchema,
  SignContractSchema,
  UpdateContractSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateContractDto extends createZodDto(CreateContractSchema) {}
class UpdateContractDto extends createZodDto(UpdateContractSchema) {}
class ChangeContractPriceDto extends createZodDto(ChangeContractPriceSchema) {}
class SignContractDto extends createZodDto(SignContractSchema) {}
class AddContractNoteDto extends createZodDto(AddContractNoteSchema) {}
class CancelContractDto extends createZodDto(CancelContractSchema) {}
class AssignInsuranceDto extends createZodDto(AssignInsuranceSchema) {}

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

  @RequirePermission('contracts:read')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Contratos que vencen pronto (renovación) — declarado antes de @Get(':id'). */
  @RequirePermission('contracts:read')
  @Get('renewals')
  async renewals(@CurrentUser() user: AuthenticatedUser): Promise<ContractDto[]> {
    return this.contracts.listRenewals(user.tenantId);
  }

  @RequirePermission('contracts:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractDto> {
    return this.contracts.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:read')
  @Get(':id/events')
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractEventDto[]> {
    return this.contracts.events(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:write')
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
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('contracts:write')
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
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:write')
  @Post(':id/sign')
  @HttpCode(HttpStatus.OK)
  async sign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SignContractDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.contracts.sign({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
      // Firma asistida en el local (opcional): si el staff captura la firma.
      ...(body.method
        ? {
            signature: {
              signerName: body.signerName?.trim() || 'Firma en el local',
              method: body.method,
              signatureImage: body.method === 'drawn' ? (body.signatureImage ?? null) : null,
              typedSignature: body.method === 'typed' ? (body.typedSignature ?? null) : null,
              channel: 'in_person',
            },
          }
        : {}),
    });
  }

  @RequirePermission('contracts:manage')
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
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:manage')
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
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:manage')
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
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:manage')
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
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:write')
  @Put(':id/insurance')
  @HttpCode(HttpStatus.OK)
  async setInsurance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AssignInsuranceDto,
  ): Promise<ContractDto> {
    return this.contracts.setInsurance({
      tenantId: user.tenantId,
      contractId: id,
      facilityScope: user.facilityScope ?? null,
      planId: input.planId,
    });
  }

  @RequirePermission('contracts:write')
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
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }
}
