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
import { BulkContractsSchema, ExtendPaymentDeadlineSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PaymentDeadlineService } from './payment-deadline.service';
import { SignaturesService } from './signatures.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  BulkSignatureResultDto,
  ExtendPaymentDeadlineResultDto,
  ContractSignatureDto,
  ContractSigningRecordDto,
  RequestSignatureResultDto,
} from '@storageos/shared';
import type { Request } from 'express';

/** Endpoints de staff para la firma electrónica de contratos. */
class BulkContractsDto extends createZodDto(BulkContractsSchema) {}
class ExtendPaymentDeadlineDto extends createZodDto(ExtendPaymentDeadlineSchema) {}

function meta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  return { ...(ua ? { userAgent: ua } : {}), ...(req.ip ? { ipAddress: req.ip } : {}) };
}

@Controller('contracts')
export class ContractSignaturesController {
  constructor(
    private readonly signatures: SignaturesService,
    private readonly deadlines: PaymentDeadlineService,
  ) {}

  /** Envía el enlace de firma a varios borradores. Antes de `:id`. */
  @RequirePermission('contracts:write')
  @Post('bulk/request-signature')
  @HttpCode(HttpStatus.OK)
  bulkRequestSignature(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkContractsDto,
  ): Promise<BulkSignatureResultDto> {
    return this.signatures.bulkRequestSignature(
      user.tenantId,
      body.contractIds,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('contracts:write')
  @Post(':id/request-signature')
  requestSignature(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RequestSignatureResultDto> {
    return this.signatures.requestSignature(user.tenantId, id, {
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('contracts:read')
  @Get(':id/signatures')
  listSignatures(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractSignatureDto[]> {
    return this.signatures.listSignatures(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Lo que firmó (o firmará) el inquilino: texto, huella, firmas y enlace. */
  @RequirePermission('contracts:read')
  @Get(':id/signing')
  signing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractSigningRecordDto> {
    return this.signatures.signingRecord(user.tenantId, id, user.facilityScope ?? null);
  }

  /**
   * Amplía el plazo para firmar y pagar (reserva online o contrato enviado por
   * enlace): el trastero sigue reservado hasta la fecha nueva.
   */
  @RequirePermission('contracts:write')
  @Post(':id/payment-deadline')
  @HttpCode(HttpStatus.OK)
  extendPaymentDeadline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ExtendPaymentDeadlineDto,
    @Req() req: Request,
  ): Promise<ExtendPaymentDeadlineResultDto> {
    return this.deadlines.extend({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input: body,
      scope: user.facilityScope ?? null,
      meta: meta(req),
    });
  }
}
