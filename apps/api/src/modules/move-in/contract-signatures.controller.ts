import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { SignaturesService } from './signatures.service';

import type { ContractSignatureDto, RequestSignatureResultDto } from '@storageos/shared';

/** Endpoints de staff para la firma electrónica de contratos. */
@Controller('contracts')
export class ContractSignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Roles('owner', 'manager', 'staff')
  @Post(':id/request-signature')
  requestSignature(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RequestSignatureResultDto> {
    return this.signatures.requestSignature(user.tenantId, id);
  }

  @Get(':id/signatures')
  listSignatures(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractSignatureDto[]> {
    return this.signatures.listSignatures(user.tenantId, id);
  }
}
