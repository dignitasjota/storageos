import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { SignaturesService } from './signatures.service';

import type {
  ContractSignatureDto,
  ContractSigningRecordDto,
  RequestSignatureResultDto,
} from '@storageos/shared';

/** Endpoints de staff para la firma electrónica de contratos. */
@Controller('contracts')
export class ContractSignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

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
