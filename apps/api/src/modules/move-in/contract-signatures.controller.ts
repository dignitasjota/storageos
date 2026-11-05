import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { BulkContractsSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { SignaturesService } from './signatures.service';

import type {
  BulkSignatureResultDto,
  ContractSignatureDto,
  ContractSigningRecordDto,
  RequestSignatureResultDto,
} from '@storageos/shared';

/** Endpoints de staff para la firma electrónica de contratos. */
class BulkContractsDto extends createZodDto(BulkContractsSchema) {}

@Controller('contracts')
export class ContractSignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

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
}
