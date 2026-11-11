import {
  BadRequestException,
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
import { WithdrawContractSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { WithdrawalService } from './withdrawal.service';

import type { RequestMeta } from '../auth/auth.service';
import type { ContractDto, ContractWithdrawalDto } from '@storageos/shared';
import type { Request } from 'express';

class WithdrawContractDto extends createZodDto(WithdrawContractSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return { ...(ua ? { userAgent: ua } : {}), ...(ip ? { ipAddress: ip } : {}) };
}

/** Desistimiento de un contrato firmado a distancia, registrado por el equipo. */
@Controller('contracts')
export class WithdrawalController {
  constructor(private readonly withdrawal: WithdrawalService) {}

  @RequirePermission('contracts:read')
  @Get(':id/withdrawal')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('communicatedOn') communicatedOn?: string,
  ): Promise<ContractWithdrawalDto> {
    if (communicatedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(communicatedOn)) {
      throw new BadRequestException({
        code: 'invalid_communicated_on',
        message: 'Fecha no válida (YYYY-MM-DD)',
      });
    }
    return this.withdrawal.preview(user.tenantId, id, {
      facilityScope: user.facilityScope ?? null,
      ...(communicatedOn ? { communicatedOn } : {}),
    });
  }

  @RequirePermission('contracts:manage')
  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: WithdrawContractDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.withdrawal.withdraw({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      facilityScope: user.facilityScope ?? null,
      input: body,
      meta: extractMeta(req),
    });
  }
}
