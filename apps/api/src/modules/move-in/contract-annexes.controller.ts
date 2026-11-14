import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CreateContractAnnexSchema, SignContractAnnexSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ContractAnnexesService } from './contract-annexes.service';

import type { RequestMeta } from '../auth/auth.service';
import type { AnnexSignViewDto, ContractAnnexDto, ContractAnnexSentDto } from '@storageos/shared';
import type { Request } from 'express';

class CreateContractAnnexBody extends createZodDto(CreateContractAnnexSchema) {}
class SignContractAnnexBody extends createZodDto(SignContractAnnexSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/** Anexos de un contrato firmado, desde la ficha del contrato. */
@Controller('contracts/:contractId/annexes')
export class ContractAnnexesController {
  constructor(private readonly annexes: ContractAnnexesService) {}

  @RequirePermission('contracts:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
  ): Promise<ContractAnnexDto[]> {
    return this.annexes.list(user.tenantId, contractId, user.facilityScope ?? null);
  }

  /** Crea el anexo y envía al inquilino el enlace para firmarlo. */
  @RequirePermission('contracts:write')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Body() body: CreateContractAnnexBody,
    @Req() req: Request,
  ): Promise<ContractAnnexSentDto> {
    return this.annexes.create({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId,
      input: body,
      scope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:write')
  @Post(':annexId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Param('annexId', new ParseUUIDPipe()) annexId: string,
  ): Promise<ContractAnnexSentDto> {
    return this.annexes.resend(user.tenantId, contractId, annexId, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:write')
  @Post(':annexId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Param('annexId', new ParseUUIDPipe()) annexId: string,
    @Req() req: Request,
  ): Promise<ContractAnnexDto> {
    return this.annexes.cancel({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId,
      annexId,
      scope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:read')
  @Get(':annexId/pdf')
  pdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Param('annexId', new ParseUUIDPipe()) annexId: string,
  ): Promise<{ url: string }> {
    return this.annexes.pdfForStaff(user.tenantId, contractId, annexId, user.facilityScope ?? null);
  }
}

/** Firma del anexo con el enlace del correo o del área de clientes. */
@Public()
@Controller('public/annexes')
export class AnnexPublicController {
  constructor(private readonly annexes: ContractAnnexesService) {}

  @Get('sign/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  view(@Param('token') token: string): Promise<AnnexSignViewDto> {
    return this.annexes.view(token);
  }

  @Post('sign/:token')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sign(
    @Param('token') token: string,
    @Body() body: SignContractAnnexBody,
    @Req() req: Request,
  ): Promise<{ status: 'signed'; signedAt: string }> {
    return this.annexes.sign(token, body, extractMeta(req));
  }
}
